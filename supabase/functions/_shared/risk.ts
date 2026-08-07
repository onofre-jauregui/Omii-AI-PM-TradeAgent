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
 *  5. equity floor          (both modes) — drawdown above it governs SIZE, not pass/fail
 *  6. concentration limit   (live only)
 */
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  max_position_size: 50,
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

/**
 * Equity below this fraction of the strategy's starting balance is the ONE
 * condition that stops it outright. Everything above it degrades position size
 * and keeps trading, so a strategy always has a route back.
 */
export const EQUITY_FLOOR_PCT = 0.5;

/** Smallest order the ladder will ever place. Matches evaluateBasketConcentration's
 *  minLegUsd — below this a Kalshi order is not worth the fee and round trip. */
export const MIN_POSITION_USD = 5;

export interface DrawdownGear {
  /** Multiplier applied to the strategy's normal position size, 0.10–1.00. */
  multiplier: number;
  /** Drawdown as a fraction of the configured limit — 1.0 means "at the limit". */
  ratio: number;
  /** True when equity has fallen through EQUITY_FLOOR_PCT and trading must stop. */
  stopped: boolean;
}

/**
 * Graceful degradation for drawdown: trade smaller as losses deepen, rather than
 * stopping dead at a threshold.
 *
 * A binary halt has a perverse property — the moment a strategy most needs to
 * generate evidence about whether it still works, it is forbidden from producing
 * any. It also cannot recover, because recovery requires trades. Live S-001 sat
 * in exactly that state: a −$20 loss on a $100 account read as a drawdown breach
 * and the strategy was switched off entirely rather than de-levered.
 *
 * Tiers are on the RATIO of current drawdown to the configured limit, not on raw
 * percent, so the same ladder works for a 10% limit and a 25% one. They are
 * deliberately coarse, matching computeConcentrationCapPct above — this is a
 * governor, not a precision dial, and a smooth curve would imply an accuracy the
 * inputs do not have.
 *
 * The floor is 0.10 rather than 0: at the limit the strategy still trades, in
 * minimum size, which is what makes the ladder a gear rather than a slower off
 * switch. Only equityPct falling through EQUITY_FLOOR_PCT stops it.
 *
 * @param currentDrawdownPct fraction (0.20 = 20% below peak), from computeCurrentDrawdownPct
 * @param maxDrawdownPct     the configured limit, same units
 * @param equityPct          current equity ÷ starting balance; omit to skip the floor check
 */
export function computeDrawdownGear(
  currentDrawdownPct: number,
  maxDrawdownPct: number,
  equityPct?: number,
): DrawdownGear {
  if (equityPct !== undefined && equityPct < EQUITY_FLOOR_PCT) {
    return { multiplier: 0, ratio: Infinity, stopped: true };
  }

  // A non-positive limit means "no drawdown governor configured" — full size.
  if (!(maxDrawdownPct > 0)) {
    return { multiplier: 1, ratio: 0, stopped: false };
  }

  const ratio = Math.max(0, currentDrawdownPct) / maxDrawdownPct;

  // Tier boundaries are compared with a tolerance because the ratio is a
  // division of two decimals: 0.15 / 0.20 is 0.7499999999999999, not 0.75, so a
  // bare `ratio < 0.75` puts a strategy exactly at the boundary into the gear
  // above the one intended. Shifting the comparison by EPS makes a boundary
  // value fall on the more conservative side, which is the correct direction for
  // a risk control.
  const EPS = 1e-9;
  const multiplier =
    ratio < 0.25 - EPS ? 1 :
    ratio < 0.50 - EPS ? 0.75 :
    ratio < 0.75 - EPS ? 0.5 :
    ratio < 1.00 - EPS ? 0.25 :
    0.10;

  return { multiplier, ratio, stopped: false };
}

/**
 * Applies a gear multiplier to a proposed order size.
 *
 * Clamps UP to MIN_POSITION_USD rather than down to zero — the whole point of
 * the ladder is that minimum gear still trades. Returns 0 only when the gear
 * itself says stop, which the caller must treat as "place nothing".
 */
export function applyGearToAmount(amountUsd: number, gear: DrawdownGear): number {
  if (gear.stopped) return 0;
  const scaled = Math.round(amountUsd * gear.multiplier);
  return Math.max(MIN_POSITION_USD, scaled);
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

  // 5. Drawdown — deliberately no longer a check here.
  //
  // Drawdown now governs position SIZE, via computeDrawdownGear applied where
  // orders are sized. A strategy that is down trades smaller rather than not at
  // all, which is what gives it a route back to full size; a binary gate here
  // would re-impose the halt the ladder exists to replace.
  //
  // The equity floor — the one condition that does stop a strategy — lives with
  // the gear rather than here, and on purpose. It has to be measured against the
  // strategy's own starting balance, which this function never receives;
  // `allocated_capital` is the aggregate live-exposure cap (see
  // evaluateCapitalCap), a different quantity that would silently halt any
  // strategy whose exposure limit happens to exceed its equity. One floor, one
  // denominator, one place.
  //
  // What was here before measured `daily_pnl` against `peak_portfolio_value`
  // guarded by `daily_pnl < 0` — today's loss against an all-time peak, skipped
  // entirely on a flat day. Every stored `daily_pnl` is 0, so it had never once
  // rejected an order. Removed rather than ported: a gate that cannot fire is
  // not a control.

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
