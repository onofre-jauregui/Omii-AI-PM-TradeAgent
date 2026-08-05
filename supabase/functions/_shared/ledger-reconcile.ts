/**
 * Reconciliation of internal trade P&L against Kalshi's settlement ledger.
 *
 * The trades table books what the agent *intended*: `pnl` is derived from the
 * requested limit price and dollar amount, `settled_at` is stamped whenever the
 * auto-settle cron happened to notice, and there is no stored fill quantity. So
 * every number drifts from reality in three ways at once — wrong per-trade
 * amount (fees and fill price ignored), wrong day (cron time, not settle time),
 * and on 2026-07-27 a backfill wrote values that are arithmetically impossible
 * (a $10 position recorded as losing $21.53, and net_pnl greater than gross).
 *
 * Kalshi's /portfolio/settlements is the authoritative record: per ticker it
 * reports revenue, the actual cost basis, the fee charged, and the real
 * settlement time. This module maps that onto trade rows.
 *
 * The hard part is fan-in: one Kalshi settlement can cover many trade rows. The
 * agent placed eight separate $10 orders on KXINX-26JUL27H1600-B7437; Kalshi
 * aggregated them into a single 96-contract position and settled it once. So a
 * settlement's revenue/cost/fee is allocated across the matching rows pro rata
 * by cost basis, which is exact when the rows share a fill price and a fair
 * approximation when they don't — and the group total always ties to Kalshi.
 */

export interface KalshiSettlement {
  ticker: string;
  market_result: string;
  /** Gross payout in CENTS (integer). */
  revenue: number;
  yes_total_cost_dollars: string;
  no_total_cost_dollars: string;
  fee_cost: string;
  settled_time: string;
}

export interface ReconcilableTrade {
  id: string;
  ticker: string;
  /** Dollar size requested for this leg — the pro-rata weight. */
  amount: number | null;
  pnl: number | null;
  net_pnl: number | null;
}

export interface ReconciledRow {
  id: string;
  pnl: number;
  net_pnl: number;
  fee_cents: number;
  settled_at: string;
  resolution: string | null;
  /** True when this row's value changed materially and an UPDATE is warranted. */
  changed: boolean;
}

const CENTS = (n: number) => Math.round(n * 100) / 100;

/** Kalshi reports `market_result` as yes/no; the trades CHECK allows yes/no/void. */
export function normalizeResolution(marketResult: string): string | null {
  const r = (marketResult || "").toLowerCase();
  if (r === "yes" || r === "no") return r;
  if (r === "void" || r === "voided" || r === "cancelled" || r === "canceled") return "void";
  return null;
}

/**
 * Allocate one Kalshi settlement across the trade rows that make it up.
 *
 * Weighting is by `amount` (dollar cost basis). If every row is missing or zero
 * amount, fall back to an equal split so the group still ties out rather than
 * silently dropping the settlement.
 */
export function allocateSettlement(
  settlement: KalshiSettlement,
  trades: ReconcilableTrade[],
): ReconciledRow[] {
  if (trades.length === 0) return [];

  const revenue = settlement.revenue / 100;
  const cost = Number(settlement.yes_total_cost_dollars || 0) +
    Number(settlement.no_total_cost_dollars || 0);
  const fee = Number(settlement.fee_cost || 0);
  const resolution = normalizeResolution(settlement.market_result);

  const weights = trades.map((t) => Math.abs(Number(t.amount ?? 0)));
  const weightTotal = weights.reduce((s, w) => s + w, 0);
  const useEqual = weightTotal <= 0;

  // Allocate with running remainders so the parts sum exactly to the whole —
  // rounding each share independently would leave the group off by a cent or two
  // and reintroduce exactly the drift this function exists to remove.
  let revLeft = revenue, costLeft = cost, feeLeft = fee;

  return trades.map((t, i) => {
    const last = i === trades.length - 1;
    const share = useEqual
      ? 1 / trades.length
      : weights[i] / weightTotal;

    const rev = last ? revLeft : CENTS(revenue * share);
    const cst = last ? costLeft : CENTS(cost * share);
    const fe = last ? feeLeft : CENTS(fee * share);
    revLeft = CENTS(revLeft - rev);
    costLeft = CENTS(costLeft - cst);
    feeLeft = CENTS(feeLeft - fe);

    const gross = CENTS(rev - cst);
    const net = CENTS(gross - fe);

    // Only rewrite when it actually differs — keeps the update set small and
    // makes a re-run a genuine no-op rather than churning every row.
    const changed = t.pnl == null || t.net_pnl == null ||
      Math.abs(Number(t.pnl) - gross) >= 0.005 ||
      Math.abs(Number(t.net_pnl) - net) >= 0.005;

    return {
      id: t.id,
      pnl: gross,
      net_pnl: net,
      fee_cents: Math.round(fe * 100),
      settled_at: settlement.settled_time,
      resolution,
      changed,
    };
  });
}
