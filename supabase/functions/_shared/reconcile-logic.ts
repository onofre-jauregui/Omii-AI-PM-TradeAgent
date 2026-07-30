/**
 * Pure reconciliation logic. No I/O, no Deno imports — safe to run under Vitest
 * (Node) and Deno (edge functions). reconcile-orders supplies the Kalshi order
 * fields; this module decides how the local trade row should advance.
 */

export type ReconcileAction = "fill" | "partial" | "cancel" | "none";

// Kalshi order-status strings that mean the order will never fill further.
const TERMINAL_CANCELLED = new Set(["canceled", "cancelled", "expired"]);

// Kalshi market-status strings that mean the market has stopped trading for good —
// any order still resting against it will never be matched further.
const TERMINAL_MARKET = new Set(["finalized", "settled"]);

/**
 * Decide how a resting live order should advance.
 *
 *   canceled/expired on Kalshi                        → "cancel"
 *   remaining_count === 0 (fully filled)               → "fill"
 *   0 < remaining < initial (partial)                  → "partial"
 *   market finalized/settled and order still unmatched → "cancel"
 *   remaining === initial (still resting)               → "none"
 *
 * The market-finalized branch exists because Kalshi does not reliably flip a
 * never-matched resting order's own status to "canceled" once its market closes
 * and settles — the order object can sit at its original resting status
 * indefinitely. Without this, `reconcile-orders` would leave such trades stuck
 * "open" forever even though the exchange has no further action to take on them.
 *
 * Forward-only and idempotent: a fully-resting order on a still-open market
 * returns "none" so repeated cron runs are no-ops until Kalshi actually moves
 * the order or its market settles.
 */
export function decideReconcile(
  kalshiStatus: string,
  remainingCount: number,
  initialCount: number,
  marketStatus?: string
): ReconcileAction {
  const s = (kalshiStatus ?? "").toLowerCase();
  if (TERMINAL_CANCELLED.has(s)) return "cancel";
  if (remainingCount === 0) return "fill";
  if (remainingCount > 0 && initialCount > 0 && remainingCount < initialCount) return "partial";
  if (remainingCount > 0 && TERMINAL_MARKET.has((marketStatus ?? "").toLowerCase())) return "cancel";
  return "none";
}

/** Contracts implied by a dollar amount at a cents price — mirrors execute-trade. */
export function contractCount(amountUsd: number | null, priceCents: number | null): number {
  if (!amountUsd || !priceCents) return 0;
  return Math.floor(amountUsd / (priceCents / 100));
}

/**
 * Read the fill price (cents) from a Kalshi V2 GetOrder response.
 *
 * V2 has no avg_price/average_fill_price field at all — confirmed against a live
 * order response, which only carries `yes_price_dollars`/`no_price_dollars` (the
 * order's resting price, quoted from both sides of the book) plus fill-cost/count
 * fields. A resting limit order fills at its posted price (no slippage on our own
 * maker order), so the resting price *is* the fill price — pick the side ("yes" or
 * "no") matching our trade's `side` column. Legacy avg_price-style fields are still
 * checked first in case a future Kalshi response or a different endpoint supplies one.
 */
export function pickAvgPrice(order: any, side?: string | null): number | null {
  const legacy = order?.avg_price ?? order?.average_fill_price ?? order?.avg_fill_price ?? null;
  if (typeof legacy === "number") return legacy;

  const dollarsField = side === "no" ? order?.no_price_dollars : order?.yes_price_dollars;
  const dollars = typeof dollarsField === "string" ? parseFloat(dollarsField) : dollarsField;
  return typeof dollars === "number" && !isNaN(dollars) ? Math.round(dollars * 100) : null;
}

/**
 * Decide how a resting PAPER order should advance, given a fresh re-simulation
 * against the real orderbook (paper-reconcile). Mirrors decideReconcile's
 * forward-only/idempotent contract: a paper order only ever moves
 * open -> partial -> filled, or -> cancelled if the ticker is gone — never
 * backward, so repeated cron runs are no-ops once nothing has changed.
 */
export function decidePaperReconcile(
  tickerGone: boolean,
  filledContracts: number,
  requestedContracts: number
): ReconcileAction {
  if (tickerGone) return "cancel";
  if (filledContracts >= requestedContracts && requestedContracts > 0) return "fill";
  if (filledContracts > 0) return "partial";
  return "none";
}
