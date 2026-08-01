/**
 * Canonical Kalshi price-unit conversion. The ONLY place units are decided.
 *
 * Kalshi's market object carries every price twice:
 *   yes_ask          integer CENTS   (45 = 45¢)
 *   yes_ask_dollars  decimal DOLLARS, often a string ("0.45" = 45¢)
 *
 * Before this module, eight edge functions hand-rolled the conversion with
 * four different semantics, at least two of them wrong:
 *   - `Number(x_dollars ?? x)` treated a cents-only 45 as $45;
 *   - `parseFloat(x_dollars ?? x) * 100` turned a cents-only 45 into 4500¢;
 *   - magnitude-guessing (`v > 1 ? v : v*100`) mis-parsed a literal 1¢ as 100¢
 *     — a live bug for any 1¢ bid, and the landmine that made a user-facing
 *     price filter DSL unshippable.
 *
 * Rule: NEVER guess units from magnitude. Prefer the integer-cents field; fall
 * back to dollars×100 only when cents is absent; null when neither exists.
 */

/** Convert an explicit (centsValue, dollarsValue) pair to integer cents. */
export function kalshiPriceToCents(
  cents: unknown,
  dollars: unknown,
): number | null {
  if (cents != null && cents !== "") {
    const n = Number(cents);
    if (Number.isFinite(n)) return Math.round(n);
  }
  if (dollars != null && dollars !== "") {
    const n = Number(dollars);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return null;
}

/** Field accessor: marketFieldCents(market, "yes_ask") reads yes_ask/yes_ask_dollars. */
export function marketFieldCents(
  market: Record<string, unknown> | null | undefined,
  field: string,
): number | null {
  if (!market) return null;
  return kalshiPriceToCents(market[field], market[`${field}_dollars`]);
}
