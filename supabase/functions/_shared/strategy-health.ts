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
