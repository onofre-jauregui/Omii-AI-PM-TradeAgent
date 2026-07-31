/**
 * Pure risk-management evaluation. No I/O, no Deno imports — safe to run
 * under Vitest (Node) and Deno (edge functions).
 *
 * The caller is responsible for:
 *  - Loading risk_settings and risk_state from Supabase
 *  - Persisting compliance_log entries based on the result
 *  - Writing risk_state updates after a fill
 *
 * This module only answers the question: "given these inputs, should this
 * order be allowed through?"
 */

export interface RiskSettings {
  max_position_size: number;
  max_daily_loss: number;
  max_open_positions: number;
  max_drawdown_pct: number;
  auto_stop_loss: boolean;
  stop_loss_pct: number;
  allocated_capital: number;
}

export interface RiskState {
  date: string;
  is_trading_halted: boolean;
  halt_reason: string | null;
  daily_pnl: number;
  open_position_count: number;
  peak_portfolio_value: number;
}

export type RiskRejectionCode =
  | "position_size"
  | "trading_halted"
  | "daily_loss_limit"
  | "open_positions_limit"
  | "drawdown_limit"
  | "concentration_limit"
  | "capital_cap";

export interface RiskEvaluationResult {
  passed: boolean;
  reason?: string;
  code?: RiskRejectionCode;
  /** When the evaluation determines trading should be halted going forward */
  newHaltReason?: string;
}

/**
 * Pure evaluation of whether a proposed order passes risk checks.
 *
 * Both paper and live mode run the same checks — paper mode must simulate
 * real trading faithfully so users discover misconfigured limits before going live.
 *
 * The single exception: the 25%-concentration check is live-only. Paper
 * portfolios start at $500 and the cap would block most early paper trades.
 *
 * Order of checks:
 *  1. position size         (both modes)
 *  2. trading halted state  (both modes)
 *  3. daily loss limit      (both modes)
 *  4. open positions limit  (both modes)
 *  5. drawdown limit        (both modes)
 *  6. concentration limit   (live only)
 */
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  max_position_size: 20,
  max_open_positions: 3,
  max_daily_loss: 100,
  max_drawdown_pct: 10,
  auto_stop_loss: false,
  stop_loss_pct: 0,
  allocated_capital: 1000,
};

/**
 * Graduates the single-order concentration ceiling with proven track record
 * instead of a static 25% forever. A strategy with a handful of settled trades
 * hasn't earned the same leash as one with a large, calibrated sample —
 * `expected_hit_rate` is only as trustworthy as the sample it's built on.
 * Thresholds are deliberately coarse; this is a governor, not a precision dial.
 */
export function computeConcentrationCapPct(settledTradeCount: number): number {
  if (settledTradeCount < 30) return 10;
  if (settledTradeCount < 100) return 15;
  return 25;
}

export interface RiskContext {
  /** Real current Kalshi equity (cash + open positions), fetched fresh at
   *  decision time. Falls back to riskState.peak_portfolio_value when omitted
   *  — callers that don't pass this get the pre-existing peak-based behavior. */
  currentEquityUsd?: number | null;
  /** Settled trade count for this strategy+mode, used to graduate the
   *  concentration cap. Omitted = pre-existing flat 25% behavior. */
  settledTradeCount?: number;
}

export function evaluateRisk(
  amount: number,
  mode: "paper" | "live",
  settings: RiskSettings | null,
  riskState: RiskState | null,
  context?: RiskContext
): RiskEvaluationResult {
  // null settings = legacy / no-limits mode — pass unconditionally (no row in risk_settings yet)
  if (!settings) return { passed: true };

  // 1. Position size
  if (amount > settings.max_position_size) {
    return {
      passed: false,
      code: "position_size",
      reason: `Order amount $${amount} exceeds max position size $${settings.max_position_size}`,
    };
  }

  if (!riskState) return { passed: true };

  // 2. Trading already halted
  if (riskState.is_trading_halted) {
    return {
      passed: false,
      code: "trading_halted",
      reason: `Trading halted: ${riskState.halt_reason || "daily limits exceeded"}`,
    };
  }

  // 3. Daily loss limit
  if (
    Math.abs(riskState.daily_pnl) >= settings.max_daily_loss &&
    riskState.daily_pnl < 0
  ) {
    return {
      passed: false,
      code: "daily_loss_limit",
      reason: `Daily loss limit of $${settings.max_daily_loss} reached. Trading halted for today.`,
      newHaltReason: `Daily loss limit of $${settings.max_daily_loss} reached`,
    };
  }

  // 4. Max open positions
  if (riskState.open_position_count >= settings.max_open_positions) {
    return {
      passed: false,
      code: "open_positions_limit",
      reason: `Maximum open positions (${settings.max_open_positions}) reached. Close a position first.`,
    };
  }

  // 5. Drawdown limit
  if (riskState.peak_portfolio_value > 0 && riskState.daily_pnl < 0) {
    const currentValue = riskState.peak_portfolio_value + riskState.daily_pnl;
    const drawdownPct =
      ((riskState.peak_portfolio_value - currentValue) /
        riskState.peak_portfolio_value) *
      100;
    if (drawdownPct >= settings.max_drawdown_pct) {
      return {
        passed: false,
        code: "drawdown_limit",
        reason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded (current: ${drawdownPct.toFixed(1)}%). Trading halted.`,
        newHaltReason: `Max drawdown of ${settings.max_drawdown_pct}% exceeded (current drawdown: ${drawdownPct.toFixed(1)}%)`,
      };
    }
  }

  // 6. Single-order concentration — live only. Sized against real CURRENT equity
  // when the caller supplies it (context.currentEquityUsd); falls back to the
  // high-water-mark peak otherwise. Peak-based sizing understates how much of
  // the account a trade actually commits after a drawdown (the peak never
  // drops), so current equity is preferred whenever it's available.
  // Paper portfolios start at $500; the cap would block most early simulation trades.
  const concentrationBasis = context?.currentEquityUsd ?? riskState.peak_portfolio_value;
  const concentrationCapPct =
    context?.settledTradeCount === undefined ? 25 : computeConcentrationCapPct(context.settledTradeCount);
  if (mode === "live" && concentrationBasis > 0) {
    const concentrationPct = (amount / concentrationBasis) * 100;
    if (concentrationPct > concentrationCapPct) {
      return {
        passed: false,
        code: "concentration_limit",
        reason: `Order amount $${amount} exceeds ${concentrationCapPct}% portfolio concentration limit (equity: $${concentrationBasis}).`,
      };
    }
  }

  return { passed: true };
}

export interface CapitalCapResult {
  passed: boolean;
  reason?: string;
  code?: Extract<RiskRejectionCode, "capital_cap">;
}

/**
 * Aggregate live-exposure cap (the "Agent Capital Limit" / allocated_capital).
 *
 * Pure: the caller supplies the already-summed open live exposure (sum of the
 * user's live trades that still hold risk — status filled/open/partial, not yet
 * settled) and the incoming order amount. Rejects when the new order would push
 * total open live exposure over allocated_capital.
 *
 * This is what makes allocated_capital a real cap on EVERY live path
 * (single order, auto-trade leg, chat) — previously it was enforced only for
 * multi-leg baskets in execute-basket.
 *
 * Live only. Paper is unbounded here by design (see evaluateRisk).
 */
export function evaluateCapitalCap(
  openExposure: number,
  amount: number,
  allocatedCapital: number
): CapitalCapResult {
  const projected = openExposure + amount;
  if (projected > allocatedCapital) {
    return {
      passed: false,
      code: "capital_cap",
      reason: `Order $${amount} would raise open live exposure to $${projected.toFixed(2)}, over the Agent Capital Limit of $${allocatedCapital}. Close positions or raise the limit.`,
    };
  }
  return { passed: true };
}

export interface BasketConcentrationResult {
  /** true if legs had to be scaled down to fit the cap */
  scaled: boolean;
  /** the dollar cap the basket was measured against */
  capUsd: number;
  /** same length/order as the input legAmounts; a leg scaled below minLegUsd is 0 (drop it) */
  amounts: number[];
}

/**
 * Caps a MULTI-LEG BASKET's total exposure, not just each leg in isolation.
 *
 * evaluateRisk()'s concentration check runs per order — fine for independent
 * bets, wrong for a strategy like S-001 that fires several legs against
 * brackets on the SAME underlying event in one cycle. Those legs are
 * correlated: each can individually clear a 25%-of-equity check while the
 * basket as a whole commits far more than 25% to one outcome. This scales
 * every leg down proportionally so the basket's TOTAL respects the same
 * concentration ceiling evaluateRisk() would apply to a single order.
 *
 * Pure — no I/O. The caller supplies current equity and the same
 * concentrationCapPct it would pass to evaluateRisk (see
 * computeConcentrationCapPct) so the two stay consistent.
 */
export function evaluateBasketConcentration(
  legAmounts: number[],
  currentEquityUsd: number,
  concentrationCapPct: number,
  minLegUsd = 5
): BasketConcentrationResult {
  const capUsd = (currentEquityUsd * concentrationCapPct) / 100;
  const total = legAmounts.reduce((sum, a) => sum + a, 0);

  if (total <= 0 || total <= capUsd) {
    return { scaled: false, capUsd, amounts: legAmounts };
  }

  const scaleFactor = capUsd / total;
  const amounts = legAmounts
    .map((a) => Math.floor(a * scaleFactor))
    .map((a) => (a < minLegUsd ? 0 : a));

  return { scaled: true, capUsd, amounts };
}
