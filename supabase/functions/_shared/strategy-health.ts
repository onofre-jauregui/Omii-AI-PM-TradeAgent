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
