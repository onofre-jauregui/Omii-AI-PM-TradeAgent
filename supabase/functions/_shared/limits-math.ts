/**
 * Pure clamp math for effective trading limits — NO I/O, no Deno-only imports,
 * safe to run under Vitest (Node) and Deno. The I/O wrapper lives in limits.ts.
 *
 * This is deliberately separate from limits.ts: limits.ts imports tenant.ts,
 * which imports the Supabase client from an npm: specifier that Vitest can't resolve.
 * Keeping the testable math here lets limits.test.ts import a pure chain.
 *
 * See limits.ts for the full behavior contract (PR2 = behavior-preserving).
 */

import { type TierLimits } from "./billing.ts";
import { DEFAULT_RISK_SETTINGS, type RiskSettings } from "./risk.ts";

/** Fallback daily-trade cap when a risk row lacks the column (matches the DB default). */
export const DEFAULT_MAX_DAILY_TRADES = 30;

export interface EffectiveLimits {
  mode: "paper" | "live";
  /** True iff a real risk_settings row exists for (user_id, mode). */
  configured: boolean;
  /** risk_settings.allocated_capital — the anchor value (used as-is here; the derivation source in PR5). */
  allocatedCapital: number;
  /** Subscription tier ceiling. */
  tier: TierLimits;
  /** Full normalized risk row, for evaluateRisk / evaluateCapitalCap reuse. */
  riskSettings: RiskSettings;
  /** Effective max USD per single order. */
  maxPositionUsd: number;
  /** Effective max simultaneously-open positions. */
  maxOpenPositions: number;
  /** Effective max trades per 24h window. */
  maxDailyTrades: number;
}

/**
 * Normalize a raw risk_settings row (or null) into a typed RiskSettings.
 * A null/absent row yields DEFAULT_RISK_SETTINGS — the caller decides whether
 * "not configured" should fail closed (execute-trade does, for live).
 */
export function normalizeRiskRow(riskRow: Record<string, unknown> | null): RiskSettings {
  if (!riskRow) return { ...DEFAULT_RISK_SETTINGS };
  const num = (v: unknown, d: number) => (v == null ? d : Number(v));
  return {
    max_position_size: num(riskRow.max_position_size, DEFAULT_RISK_SETTINGS.max_position_size),
    max_daily_loss: num(riskRow.max_daily_loss, DEFAULT_RISK_SETTINGS.max_daily_loss),
    max_open_positions: num(riskRow.max_open_positions, DEFAULT_RISK_SETTINGS.max_open_positions),
    max_drawdown_pct: num(riskRow.max_drawdown_pct, DEFAULT_RISK_SETTINGS.max_drawdown_pct),
    auto_stop_loss: riskRow.auto_stop_loss == null ? DEFAULT_RISK_SETTINGS.auto_stop_loss : Boolean(riskRow.auto_stop_loss),
    stop_loss_pct: num(riskRow.stop_loss_pct, DEFAULT_RISK_SETTINGS.stop_loss_pct),
    allocated_capital: num(riskRow.allocated_capital, DEFAULT_RISK_SETTINGS.allocated_capital),
  };
}

/**
 * Pure clamp math. Given the raw risk row, the resolved tier ceiling, and the
 * mode, produce the effective numeric limits.
 *
 * Behavior (PR2 — behavior-preserving consolidation):
 *   - maxPositionUsd / maxOpenPositions: live → min(user, tier); paper → user.
 *     Paper is unconstrained by the tier position/open caps (only live money is).
 *   - maxDailyTrades: min(user, tier) in BOTH modes — unifies the two daily
 *     counters that used to be enforced independently (the stricter of the two).
 */
export function computeEffectiveLimits(
  riskRow: Record<string, unknown> | null,
  tier: TierLimits,
  mode: "paper" | "live",
): Omit<EffectiveLimits, "mode" | "tier"> {
  const configured = riskRow != null;
  const rs = normalizeRiskRow(riskRow);
  const rowDailyTrades = riskRow?.max_daily_trades == null
    ? DEFAULT_MAX_DAILY_TRADES
    : Number(riskRow.max_daily_trades);

  const maxPositionUsd = mode === "live"
    ? Math.min(rs.max_position_size, tier.maxPositionUsd)
    : rs.max_position_size;
  const maxOpenPositions = mode === "live"
    ? Math.min(rs.max_open_positions, tier.maxOpenPositions)
    : rs.max_open_positions;
  const maxDailyTrades = Math.min(rowDailyTrades, tier.maxTradesPerDay);

  return {
    configured,
    allocatedCapital: rs.allocated_capital,
    riskSettings: rs,
    maxPositionUsd,
    maxOpenPositions,
    maxDailyTrades,
  };
}
