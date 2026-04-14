import { describe, it, expect } from "vitest";
import { evaluateRisk, type RiskSettings, type RiskState } from "./risk";

const baseSettings: RiskSettings = {
  max_position_size: 500,
  max_daily_loss: 500,
  max_open_positions: 10,
  max_drawdown_pct: 20,
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
    it("bypasses all checks in paper mode", () => {
      const result = evaluateRisk(999_999, "paper", baseSettings, {
        ...baseState,
        is_trading_halted: true,
        halt_reason: "stopped",
      });
      expect(result.passed).toBe(true);
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

  describe("drawdown limit", () => {
    it("rejects when drawdown exceeds max_drawdown_pct", () => {
      // Peak 1000, daily P&L -250 → drawdown = 25%, exceeds 20%
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -250,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(false);
      expect(result.code).toBe("drawdown_limit");
      expect(result.newHaltReason).toBeDefined();
    });

    it("allows when drawdown is within limit", () => {
      // Peak 1000, daily P&L -100 → drawdown = 10%, under 20%
      const result = evaluateRisk(100, "live", baseSettings, {
        ...baseState,
        daily_pnl: -100,
        peak_portfolio_value: 1000,
      });
      expect(result.passed).toBe(true);
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
