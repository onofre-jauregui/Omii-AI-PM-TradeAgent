/**
 * Pure basket-lifecycle logic for execute-basket — no external imports so it
 * can be tested under vitest without the Deno/ESM CDN dependencies index.ts
 * requires.
 */

export interface LegResult {
  success: boolean;
  trade?: { status?: string } | null;
}

export interface FlattenResult {
  success: boolean;
}

/** A leg only counts as filled if execute-trade both returned success AND the
 *  trade actually has fill contracts (status filled/partial) — a `success:
 *  true` response with status "open" is a resting, unfilled order (e.g. no
 *  real liquidity at the requested price, or — see DESIGN-REPORT.md §6 — a
 *  nonexistent/typo'd ticker, which execute-trade doesn't hard-reject).
 *  Previously this function treated any `success:true` leg as filled, which
 *  let a basket where a leg never actually filled still get reported
 *  "completed" — the exact naked-exposure scenario baskets exist to prevent,
 *  just via an unfilled resting leg instead of an execution error. */
export function didLegFill(legResult: LegResult): boolean {
  return legResult.success === true && (legResult.trade?.status === "filled" || legResult.trade?.status === "partial");
}

/** Determines the basket's terminal status once all legs have been attempted,
 *  before any flatten step runs. */
export function determineBasketStatus(
  legResults: LegResult[],
  legCount: number,
  filledLegCount: number,
  abortReason: string | null
): "completed" | "partially_filled" | "timed_out" | "aborted" {
  const allFilled = legResults.filter(didLegFill).length === legCount;
  const anyFilled = filledLegCount > 0;

  if (allFilled) return "completed";
  if (abortReason && anyFilled) return "partially_filled";
  if (abortReason) return abortReason.includes("timed out") ? "timed_out" : "aborted";
  return "aborted";
}

/**
 * Determines whether a flatten attempt actually resolved the basket's naked
 * exposure. A basket is only "flattened" if EVERY filled leg's closing order
 * succeeded — previously the caller flipped status to "flattened" whenever
 * flattenResults was merely non-empty, which included entries for FAILED
 * flatten attempts (execute-trade returning success:false, or the fetch
 * throwing). That meant a basket left with real naked live exposure could be
 * reported as safely resolved — the exact failure mode this function exists
 * to prevent.
 *
 * Returns "flattened" only when fully resolved; otherwise "flatten_failed"
 * (needs a critical alert — a human must manually close the position) or
 * "not_attempted" when there was nothing to flatten.
 */
export function resolveFlattenOutcome(
  flattenResults: FlattenResult[],
  filledLegCount: number
): "flattened" | "flatten_failed" | "not_attempted" {
  if (flattenResults.length === 0) return "not_attempted";
  const flattenedCount = flattenResults.filter(r => r.success).length;
  if (flattenedCount > 0 && flattenedCount === filledLegCount) return "flattened";
  return "flatten_failed";
}
