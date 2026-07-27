/**
 * Pure reconciliation logic. No I/O, no Deno imports — safe to run under Vitest
 * (Node) and Deno (edge functions). reconcile-orders supplies the Kalshi order
 * fields; this module decides how the local trade row should advance.
 */

export type ReconcileAction = "fill" | "partial" | "cancel" | "none";

// Kalshi order-status strings that mean the order will never fill further.
const TERMINAL_CANCELLED = new Set(["canceled", "cancelled", "expired"]);

/**
 * Decide how a resting live order should advance.
 *
 *   canceled/expired on Kalshi          → "cancel"
 *   remaining_count === 0 (fully filled) → "fill"
 *   0 < remaining < initial (partial)    → "partial"
 *   remaining === initial (still resting) → "none"
 *
 * Forward-only and idempotent: a fully-resting order returns "none" so repeated
 * cron runs are no-ops until Kalshi actually moves the order.
 */
export function decideReconcile(
  kalshiStatus: string,
  remainingCount: number,
  initialCount: number
): ReconcileAction {
  const s = (kalshiStatus ?? "").toLowerCase();
  if (TERMINAL_CANCELLED.has(s)) return "cancel";
  if (remainingCount === 0) return "fill";
  if (remainingCount > 0 && initialCount > 0 && remainingCount < initialCount) return "partial";
  return "none";
}

/** Contracts implied by a dollar amount at a cents price — mirrors execute-trade. */
export function contractCount(amountUsd: number | null, priceCents: number | null): number {
  if (!amountUsd || !priceCents) return 0;
  return Math.floor(amountUsd / (priceCents / 100));
}

/** Read the average fill price (cents) from a Kalshi order object, tolerating field-name variants. */
export function pickAvgPrice(order: any): number | null {
  const v = order?.avg_price ?? order?.average_fill_price ?? order?.avg_fill_price ?? null;
  return typeof v === "number" ? v : null;
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
