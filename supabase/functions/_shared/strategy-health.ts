/**
 * Pure strategy-health metrics. No I/O, no Deno imports — safe to run
 * under Vitest (Node) and Deno (edge functions).
 *
 * Drawdown must be measured against the strategy's actual capital base
 * (starting balance + cumulative P&L), not against the raw cumulative P&L
 * peak. Peak cumulative P&L can be a tiny dollar amount early in a trade
 * sequence (e.g. $2), so (peak - trough) / peak explodes past 100% for
 * perfectly ordinary dollar swings — this previously force-suspended
 * strategies with a net-positive total P&L over impossible "543.9%" and
 * "1695.7%" drawdown readings (2026-07-30/31 compliance_log rows).
 */
export function computeMaxDrawdownPct(
  pnls: number[],
  startingBalance: number,
): number {
  const base = startingBalance > 0 ? startingBalance : 1;
  let peakEquity = base;
  let runningEquity = base;
  let maxDdPct = 0;

  for (const pnl of pnls) {
    runningEquity += pnl;
    peakEquity = Math.max(peakEquity, runningEquity);
    const dd = (peakEquity - runningEquity) / peakEquity;
    maxDdPct = Math.max(maxDdPct, dd);
  }

  return maxDdPct;
}

/**
 * Applies a strategy's risk-baseline reset to the trailing-trade-window query
 * used by Sharpe/drawdown/hit-rate/consecutive-loss evaluation.
 *
 * That window is a fixed count (last 30 settled trades), not time-scoped, so
 * for a low-volume strategy it can BE the strategy's entire history — a couple
 * of bad trades from before a root-cause fix ships can never age out on their
 * own, because staying suspended blocks the new trades that would eventually
 * push them out of the window (2026-08 S-001-live lockup: auto-resumed and
 * immediately re-suspended on the same 40.7%-drawdown reading for 4+ days).
 *
 * risk_baseline_reset_at is set only by a deliberate human override of an
 * active suspension (never by routine 24h auto-resume — that would let a
 * persistently bad strategy escape evaluation forever). NULL means no reset
 * has occurred: evaluate the full window, unchanged from today's behavior.
 */
export function applyRiskBaselineFilter<T>(
  query: T,
  riskBaselineResetAt: string | null | undefined,
): T {
  if (!riskBaselineResetAt) return query;
  // deno-lint-ignore no-explicit-any
  return (query as any).gte("settled_at", riskBaselineResetAt) as T;
}

export type AutoResumeReason =
  | "insufficient_sample"
  | "positive_expectancy"
  | "negative_expectancy";

export interface AutoResumeVerdict {
  resume: boolean;
  expectancy: number;
  sampleSize: number;
  reason: AutoResumeReason;
}

/** Settled trades required before expectancy is trusted enough to block a resume. */
export const MIN_EXPECTANCY_SAMPLE = 20;

/**
 * Decides whether a suspended strategy has earned its automatic resume.
 *
 * The suspension timer alone only asks "has enough time passed", never "is this
 * strategy actually making money". A strategy with negative expectancy therefore
 * cycles: lose → suspend → wait out the window → auto-resume → lose again. S-005
 * ran exactly this loop on a ~13h period across every account that had it enabled,
 * so the default state of a new user was a revolving loss loop rather than the
 * one-time drawdown the suspension was designed to contain.
 *
 * A negative-expectancy strategy is held instead of resumed. The hold is not a
 * longer timer — it clears suspended_until so no timer can ever lift it, which
 * makes re-enabling a deliberate human act. That act already exists: an operator
 * re-enabling an suspension sets risk_baseline_reset_at, and
 * applyRiskBaselineFilter then scopes evaluation to trades settled after the fix.
 * That is what keeps this from recreating the 2026-08 S-001-live lockup, where a
 * strategy auto-resumed and immediately re-suspended on the same stale reading
 * for four days with no way for the window to age out.
 *
 * Below MIN_EXPECTANCY_SAMPLE settled trades the verdict is always resume: a
 * handful of losses is the noise the timer exists to absorb, and blocking on it
 * would strand every new strategy before it had a record at all.
 */
export function evaluateAutoResume(
  pnls: number[],
  minSample: number = MIN_EXPECTANCY_SAMPLE,
): AutoResumeVerdict {
  const sampleSize = pnls.length;

  if (sampleSize < minSample) {
    return { resume: true, expectancy: 0, sampleSize, reason: "insufficient_sample" };
  }

  const expectancy = pnls.reduce((sum, p) => sum + p, 0) / sampleSize;

  // Break-even resumes. The bar is "does not lose money", not "clears a hurdle" —
  // a stricter test here would suspend strategies for ordinary variance.
  return expectancy >= 0
    ? { resume: true, expectancy, sampleSize, reason: "positive_expectancy" }
    : { resume: false, expectancy, sampleSize, reason: "negative_expectancy" };
}
