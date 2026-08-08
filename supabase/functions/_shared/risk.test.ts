import { describe, it, expect } from "vitest";
import {
  evaluateRisk,
  evaluateCapitalCap,
  evaluateBasketConcentration,
  computeConcentrationCapPct,
  computeDrawdownGear,
  applyGearToAmount,
  EQUITY_FLOOR_PCT,
  MIN_POSITION_USD,
  type RiskSettings,
  type RiskState,
} from "./risk";

const baseSettings: RiskSettings = {
  max_position_size: 500,
  max_daily_loss: 500,
  max_open_positions: 10,
  max_drawdown_pct: 20,
  auto_stop_loss: false,
  stop_loss_pct: 0,
  allocated_capital: 1000,
};

const baseState: RiskState = {
  date: "2026-04-14",
  is_trading_halted: false,
  halt_reason: null,
  daily_pnl: 0,
  open_position_count: 0,
  peak_portfolio_value: 1000,
};

describe("evaluateRisk", () => {
  describe("paper mode", () => {
    it("applies same risk checks in paper mode as live mode", () => {
      // Paper mode intentionally mirrors live — training must match production behavior.
      // A halted state in paper mode should still block, same as live.
      const result = evaluateRisk(999_999, "paper", baseSettings, {
        ...baseState,
        is_trading_halted: true,
        halt_reason: "stopped",
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("position_size");
    });
  });

  describe("missing config", () => {
    it("passes when settings are null (legacy / no-limits mode)", () => {
      const result = evaluateRisk(100, "live", null, baseState);
      expect(result.passed).toBe(true);
    });

    it("passes when state is null (no risk_state row yet today)", () => {
      const result = evaluateRisk(100, "live", baseSettings, null);
      expect(result.passed).toBe(true);
    });
  });

  describe("position size limit", () => {
    it("rejects orders larger than max_position_size", () => {
      const result = evaluateRisk(501, "live", baseSettings, baseState);
      expect(result.passed).toBe(false);
      expect(result.code).toBe("position_size");
      expect(result.reason).toContain("max position size");
    });

    it("allows orders equal to max_position_size when concentration is fine", () => {
      // Use a larger peak portfolio so the concentration check (>25%) doesn't fire
      const result = evaluateRisk(500, "live", baseSettings, {
        ...baseState,
        peak_portfolio_value: 10_000,
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("trading halted state", () => {
    it("rejects when trading is already halted", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        is_trading_halted: true,
        halt_reason: "manual halt",
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("trading_halted");
      expect(result.reason).toContain("manual halt");
    });

    it("falls back to default reason when halt_reason is null", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        is_trading_halted: true,
        halt_reason: null,
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("daily limits exceeded");
    });
  });

  describe("daily loss limit", () => {
    it("rejects when daily loss meets the limit", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -500,
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("daily_loss_limit");
      expect(result.newHaltReason).toBeDefined();
    });

    it("rejects when daily loss exceeds the limit", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -750,
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("daily_loss_limit");
    });

    it("does not trigger on positive daily P&L of equivalent magnitude", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: 500,
        peak_portfolio_value: 10_000, // avoid concentration trigger
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("open positions limit", () => {
    it("rejects when at the open positions cap", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        open_position_count: 10,
        peak_portfolio_value: 10_000,
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("open_positions_limit");
    });

    it("allows when below the open positions cap", () => {
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        open_position_count: 9,
        peak_portfolio_value: 10_000,
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("drawdown no longer halts on its own", () => {
    // Drawdown governs position size via computeDrawdownGear, not pass/fail here.
    // The equity floor lives with the gear so it can be measured against the
    // strategy's own starting balance rather than allocated_capital.

    it("passes an order that the old daily_pnl-vs-peak check would have rejected", () => {
      // Peak 1000, daily P&L -250 → 25% by the old measure, over the 20% limit.
      // This is the exact case that switched live S-001 off; it must now pass and
      // be handled by sizing instead.
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -250,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(true);
    });

    it("passes even at a drawdown far beyond the configured limit", () => {
      // -499 against a 1000 peak is a ~50% drawdown, well past the 20% limit,
      // while staying inside max_daily_loss (500) so the daily-loss check —
      // which correctly fires first — isn't what we end up asserting on.
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -499,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(true);
    });

    it("never returns a drawdown_limit rejection", () => {
      // The code is retained on the type for the halt-state reason string, but
      // evaluateRisk must no longer be a source of it.
      for (const dailyPnl of [-100, -250, -400, -499]) {
        const result = evaluateRisk(100, "live", baseSettings, {
          ...baseState,
          daily_pnl: dailyPnl,
          peak_portfolio_value: 1000,
        });
        expect(result.code).not.toBe("drawdown_limit");
      }
    });
  });

  describe("single-order concentration limit", () => {
    it("rejects orders > 25% of peak portfolio value", () => {
      // 300 / 1000 = 30%, exceeds 25%
      const result = evaluateRisk(300, "live", baseSettings, {
        ...baseState,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("concentration_limit");
    });

    it("allows orders at exactly 25% of peak portfolio value", () => {
      // 250 / 1000 = 25%, at limit
      const result = evaluateRisk(250, "live", baseSettings, {
        ...baseState,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(true);
    });

    it("does not check concentration when peak portfolio value is zero", () => {
      const result = evaluateRisk(400, "live", baseSettings, {
        ...baseState,
        peak_portfolio_value: 0,
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("check ordering", () => {
    it("position size check fires before trading-halted check", () => {
      // Both would fail, but position size is checked first
      const result = evaluateRisk(501, "live", baseSettings, {
        ...baseState,
        is_trading_halted: true,
      });
      expect(result.code).toBe("position_size");
    });

    it("daily loss check fires before drawdown check when both apply", () => {
      // daily_pnl -500 hits both daily loss limit (=500) and drawdown
      // (50% of 1000). Daily loss is checked first.
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -500,
        peak_portfolio_value: 1000,
      });
      expect(result.code).toBe("daily_loss_limit");
    });
  });
});

describe("evaluateCapitalCap", () => {
  it("allows an order when open exposure + amount is under the cap", () => {
    const r = evaluateCapitalCap(300, 100, 500);
    expect(r.passed).toBe(true);
  });

  it("allows an order that lands exactly on the cap", () => {
    const r = evaluateCapitalCap(400, 100, 500);
    expect(r.passed).toBe(true);
  });

  it("rejects an order that would exceed the cap", () => {
    const r = evaluateCapitalCap(400, 101, 500);
    expect(r.passed).toBe(false);
    expect(r.code).toBe("capital_cap");
    expect(r.reason).toContain("Agent Capital Limit");
  });

  it("rejects the very first order when it alone exceeds the cap", () => {
    const r = evaluateCapitalCap(0, 600, 500);
    expect(r.passed).toBe(false);
    expect(r.code).toBe("capital_cap");
  });
});

describe("computeConcentrationCapPct", () => {
  it("is conservative under 30 settled trades", () => {
    expect(computeConcentrationCapPct(0)).toBe(10);
    expect(computeConcentrationCapPct(29)).toBe(10);
  });

  it("widens between 30 and 100 settled trades", () => {
    expect(computeConcentrationCapPct(30)).toBe(15);
    expect(computeConcentrationCapPct(99)).toBe(15);
  });

  it("reaches the full 25% only once a real sample exists", () => {
    expect(computeConcentrationCapPct(100)).toBe(25);
    expect(computeConcentrationCapPct(10_000)).toBe(25);
  });
});

describe("evaluateRisk with currentEquityUsd context", () => {
  it("sizes concentration off current equity, not a stale high peak", () => {
    // Peak is $1000 (pre-drawdown), but real current equity is only $100 —
    // a $30 order is 30% of current equity and should be rejected even
    // though it's only 3% of the stale peak.
    const result = evaluateRisk(
      30,
      "live",
      baseSettings,
      { ...baseState, peak_portfolio_value: 1000 },
      { currentEquityUsd: 100, settledTradeCount: 100 }
    );
    expect(result.passed).toBe(false);
    expect(result.code).toBe("concentration_limit");
  });

  it("falls back to peak_portfolio_value when currentEquityUsd is omitted", () => {
    const result = evaluateRisk(300, "live", baseSettings, {
      ...baseState,
      peak_portfolio_value: 1000,
    });
    expect(result.passed).toBe(false);
    expect(result.code).toBe("concentration_limit");
  });

  it("graduates the cap tighter for a thin settled-trade sample", () => {
    // 15 / 100 equity = 15%, would pass the old flat 25% but fails a thin-sample 10% cap
    const result = evaluateRisk(
      15,
      "live",
      baseSettings,
      { ...baseState, peak_portfolio_value: 1000 },
      { currentEquityUsd: 100, settledTradeCount: 5 }
    );
    expect(result.passed).toBe(false);
    expect(result.code).toBe("concentration_limit");
  });

  it("allows the same order once the sample graduates the cap to 25%", () => {
    const result = evaluateRisk(
      15,
      "live",
      baseSettings,
      { ...baseState, peak_portfolio_value: 1000 },
      { currentEquityUsd: 100, settledTradeCount: 200 }
    );
    expect(result.passed).toBe(true);
  });
});

describe("evaluateBasketConcentration", () => {
  it("passes through unscaled when the basket total is under the cap", () => {
    const r = evaluateBasketConcentration([10, 10, 5], 100, 25);
    expect(r.scaled).toBe(false);
    expect(r.amounts).toEqual([10, 10, 5]);
  });

  it("scales every leg proportionally when the basket total exceeds the cap", () => {
    // Cap = 25% of $100 = $25. Legs sum to $50 → scale factor 0.5.
    const r = evaluateBasketConcentration([20, 20, 10], 100, 25);
    expect(r.scaled).toBe(true);
    expect(r.capUsd).toBe(25);
    expect(r.amounts).toEqual([10, 10, 5]);
    expect(r.amounts.reduce((s, a) => s + a, 0)).toBeLessThanOrEqual(r.capUsd);
  });

  it("drops legs that scale below the minimum viable size", () => {
    // Cap = 10% of $100 = $10. Legs [21, 22] sum to $43 → scale factor ~0.23,
    // each leg lands under the $5 floor and should be dropped (0), not sent tiny.
    const r = evaluateBasketConcentration([21, 22], 100, 10, 5);
    expect(r.scaled).toBe(true);
    expect(r.amounts.every((a) => a === 0 || a >= 5)).toBe(true);
  });

  it("treats a zero or negative total as nothing to scale", () => {
    const r = evaluateBasketConcentration([], 100, 25);
    expect(r.scaled).toBe(false);
    expect(r.amounts).toEqual([]);
  });
});

describe("computeDrawdownGear", () => {
  const LIMIT = 0.20; // 20% configured drawdown limit

  it("runs at full size while drawdown is under a quarter of the limit", () => {
    expect(computeDrawdownGear(0, LIMIT).multiplier).toBe(1);
    expect(computeDrawdownGear(0.049, LIMIT).multiplier).toBe(1);
  });

  it("steps down through each gear as drawdown deepens", () => {
    expect(computeDrawdownGear(0.05, LIMIT).multiplier).toBe(0.75); // 25% of limit
    expect(computeDrawdownGear(0.10, LIMIT).multiplier).toBe(0.5);  // 50%
    expect(computeDrawdownGear(0.15, LIMIT).multiplier).toBe(0.25); // 75%
    expect(computeDrawdownGear(0.20, LIMIT).multiplier).toBe(0.10); // at the limit
  });

  it("keeps trading in minimum gear past the limit rather than stopping", () => {
    // The whole point of the ladder: at and beyond the limit the strategy is
    // still in the market, small, and can trade its way back.
    const wayPast = computeDrawdownGear(0.60, LIMIT);
    expect(wayPast.multiplier).toBe(0.10);
    expect(wayPast.stopped).toBe(false);
  });

  it("raises the gear again as equity recovers — a gear, not a ratchet", () => {
    const deep = computeDrawdownGear(0.18, LIMIT).multiplier;
    const recovered = computeDrawdownGear(0.06, LIMIT).multiplier;
    const healed = computeDrawdownGear(0.01, LIMIT).multiplier;
    expect(deep).toBeLessThan(recovered);
    expect(recovered).toBeLessThan(healed);
    expect(healed).toBe(1);
  });

  it("stops only when equity falls through the floor", () => {
    const justAbove = computeDrawdownGear(0.5, LIMIT, EQUITY_FLOOR_PCT);
    expect(justAbove.stopped).toBe(false);

    const below = computeDrawdownGear(0.5, LIMIT, EQUITY_FLOOR_PCT - 0.01);
    expect(below.stopped).toBe(true);
    expect(below.multiplier).toBe(0);
  });

  it("runs at full size when no drawdown limit is configured", () => {
    expect(computeDrawdownGear(0.9, 0).multiplier).toBe(1);
    expect(computeDrawdownGear(0.9, -1).multiplier).toBe(1);
  });

  it("treats a negative drawdown (equity above peak) as no drawdown", () => {
    expect(computeDrawdownGear(-0.1, LIMIT).multiplier).toBe(1);
  });
});

describe("applyGearToAmount", () => {
  it("scales the order by the gear", () => {
    expect(applyGearToAmount(100, computeDrawdownGear(0.10, 0.20))).toBe(50);
    expect(applyGearToAmount(100, computeDrawdownGear(0.05, 0.20))).toBe(75);
  });

  it("clamps up to the minimum order rather than down to nothing", () => {
    // $15 leg at minimum gear is $1.50 — below what is worth placing. The ladder
    // floors it at MIN_POSITION_USD so the strategy keeps trading.
    const minGear = computeDrawdownGear(0.30, 0.20);
    expect(applyGearToAmount(15, minGear)).toBe(MIN_POSITION_USD);
  });

  it("returns zero only when the gear says stop", () => {
    const stopped = computeDrawdownGear(0.5, 0.20, 0.1);
    expect(applyGearToAmount(100, stopped)).toBe(0);
  });

  it("leaves a full-gear order untouched", () => {
    expect(applyGearToAmount(15, computeDrawdownGear(0, 0.20))).toBe(15);
  });
});
