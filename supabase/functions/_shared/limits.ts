/**
 * Single source of truth for a user's *effective* trading limits, per mode.
 *
 * Before this module the same "what are this user's real limits right now"
 * logic was re-implemented inline in execute-trade, execute-basket, auto-trade,
 * and trading-agent — and they drifted (that divergence is what produced the
 * live-trade-rejection bug). Every caller should resolve limits here instead.
 *
 * The effective limit for each dimension is the interaction of two inputs:
 *   - the user's own risk_settings row for (user_id, mode)
 *   - the subscription tier ceiling (billing.ts TIER_DEFINITIONS)
 *
 * The pure clamp math lives in limits-math.ts (unit-tested without a DB); this
 * file adds the I/O that fetches those two inputs. It is separate because it
 * imports tenant.ts, whose Supabase-client esm.sh import Vitest can't resolve.
 */

import { getRiskSettings } from "./tenant.ts";
import { resolveLimits, type SubscriptionRow } from "./billing.ts";
import { computeEffectiveLimits, type EffectiveLimits } from "./limits-math.ts";

// Re-export the pure surface so callers have one import site.
export {
  computeEffectiveLimits,
  normalizeRiskRow,
  DEFAULT_MAX_DAILY_TRADES,
  type EffectiveLimits,
} from "./limits-math.ts";

/**
 * Resolve a user's effective limits for a mode. Two queries (mode-scoped
 * risk_settings + subscription), then pure clamping.
 */
export async function resolveEffectiveLimits(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string | null,
  mode: "paper" | "live",
): Promise<EffectiveLimits & { subscription: SubscriptionRow | null }> {
  const [riskRow, sub] = await Promise.all([
    getRiskSettings(supabase, userId, mode),
    userId
      ? supabase.from("subscriptions").select("*").eq("user_id", userId).maybeSingle()
          .then((r: { data: unknown }) => (r?.data ?? null))
      : Promise.resolve(null),
  ]);
  const subscription = sub as SubscriptionRow | null;
  const tier = resolveLimits(subscription);
  return { mode, tier, subscription, ...computeEffectiveLimits(riskRow, tier, mode) };
}

/**
 * Count a user's trades in the trailing window, scoped to a mode. Replaces the
 * two independent 24h counters (execute-trade tier cap, auto-trade daily cap).
 */
export async function countTradesInWindow(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string | null,
  mode: "paper" | "live",
  windowHours = 24,
): Promise<number> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  let q = supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("mode", mode)
    .neq("status", "failed")
    .gte("created_at", since);
  q = userId ? q.eq("user_id", userId) : q.is("user_id", null);
  const { count } = await q;
  return count ?? 0;
}
