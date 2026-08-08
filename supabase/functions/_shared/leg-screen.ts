/**
 * S-001 leg screening — why a candidate leg was not tradeable.
 *
 * The screen itself is not new; it has always lived inline in auto-trade's
 * `tradeable` filter as a chain of bare `return false` statements, followed by
 * `if (tradeable.length === 0) continue`. That is the problem this module
 * exists to fix: every rejected leg vanished without a record, so a day on
 * which live placed no orders was indistinguishable from a day on which no
 * opportunity existed.
 *
 * That distinction is the open question about this strategy. Measured over 508
 * settled S-001 trades, entries below 80c carry a +19 point margin over their
 * break-even win rate while entries at 85c+ carry a negative one, which is why
 * `MAX_ENTRY_PRICE_CENTS` exists. But every live fill to date landed at 80c+,
 * so nobody knows whether the profitable band is reachable with real money or
 * merely never attempted. Counting rejects by reason answers it: if legs are
 * lost to `entry_price_cap`, the book sits in the unprofitable band and there
 * was nothing to win; if they are lost to `fee_hurdle` or survive the screen
 * and then fail to fill, the edge is real but unreachable.
 *
 * Pulled out of the filter so the reasons are unit-testable and so the
 * ordering — which decides which single reason a leg is attributed to — is
 * explicit rather than implied by statement order in a closure.
 */

/** Reasons a leg can fail the screen, in evaluation order. */
export type LegRejectReason =
  | "price_band"
  | "entry_price_cap"
  | "already_open"
  | "fee_hurdle";

export const LEG_REJECT_REASONS: readonly LegRejectReason[] = [
  "price_band",
  "entry_price_cap",
  "already_open",
  "fee_hurdle",
] as const;

export interface LegCandidate {
  /** Live YES ask in cents. The NO entry price is 100 - yesAskCents. */
  yesAskCents: number;
  /** True when the account already holds this ticker. */
  isOpenTicker: boolean;
  /** This leg's share of the alert's expected edge, in cents. */
  perLegEdgeCents: number;
}

export interface LegScreenParams {
  /** Inclusive floor on the YES ask; below this the NO payout is too thin. */
  minAskCents: number;
  /** Inclusive ceiling on the YES ask; above this commission is not covered. */
  maxAskCents: number;
  /** Ceiling on the NO entry price — the band filter that carries the edge. */
  maxEntryPriceCents: number;
  /** Kalshi's fee as a fraction of gross winnings (0.07 = 7%). */
  feeRate: number;
  /** Absolute per-leg edge floor, applied on top of the price-scaled hurdle. */
  minNetEdgePerLegCents: number;
}

/**
 * Edge, in cents, that a NO leg at `noPriceCents` must clear just to pay the
 * fee on its own winnings. Buying NO at P risks P to win (100 - P), so the fee
 * scales with (100 - P) / P — cheap legs pay proportionally far more.
 */
export function feeHurdleCentsAt(noPriceCents: number, feeRate: number): number {
  if (noPriceCents <= 0) return Infinity;
  return ((100 - noPriceCents) / noPriceCents) * feeRate * 100;
}

/**
 * Screen one leg. Returns the first reason it fails, or null if it is
 * tradeable.
 *
 * Order matters and is deliberate: a leg outside the price band is reported as
 * `price_band` even though it would also breach the entry cap, because the band
 * check is the coarser statement about the market. Attributing each leg to
 * exactly one reason keeps the resulting histogram a partition of the
 * candidates rather than overlapping tallies that sum past the total.
 */
export function screenLeg(
  candidate: LegCandidate,
  params: LegScreenParams,
): LegRejectReason | null {
  const { yesAskCents, isOpenTicker, perLegEdgeCents } = candidate;
  const noPriceCents = 100 - yesAskCents;

  if (yesAskCents < params.minAskCents || yesAskCents > params.maxAskCents) {
    return "price_band";
  }
  if (noPriceCents > params.maxEntryPriceCents) return "entry_price_cap";
  if (isOpenTicker) return "already_open";

  const hurdle = feeHurdleCentsAt(noPriceCents, params.feeRate);
  if (perLegEdgeCents < hurdle || perLegEdgeCents < params.minNetEdgePerLegCents) {
    return "fee_hurdle";
  }
  return null;
}

export interface LegScreenSummary {
  /** Candidates examined. */
  considered: number;
  /** Candidates that passed every check. */
  tradeable: number;
  /** Reject counts, one bucket per reason. Buckets sum to considered - tradeable. */
  rejects: Record<LegRejectReason, number>;
  /**
   * NO entry prices the book actually offered, ascending. This is the field
   * that distinguishes "the market was in the unprofitable band" from "the
   * market was fine and something else stopped us" — without it the reject
   * counts say which gate fired but not how far off the market was.
   */
  noPricesSeen: number[];
}

/** Screen a batch of candidates and return both the survivors and the tally. */
export function screenLegs<T extends LegCandidate>(
  candidates: T[],
  params: LegScreenParams,
): { tradeable: T[]; summary: LegScreenSummary } {
  const rejects: Record<LegRejectReason, number> = {
    price_band: 0,
    entry_price_cap: 0,
    already_open: 0,
    fee_hurdle: 0,
  };
  const tradeable: T[] = [];
  const noPricesSeen: number[] = [];

  for (const candidate of candidates) {
    noPricesSeen.push(100 - candidate.yesAskCents);
    const reason = screenLeg(candidate, params);
    if (reason === null) tradeable.push(candidate);
    else rejects[reason] += 1;
  }

  return {
    tradeable,
    summary: {
      considered: candidates.length,
      tradeable: tradeable.length,
      rejects,
      noPricesSeen: noPricesSeen.sort((a, b) => a - b),
    },
  };
}

/**
 * The reason that accounts for the most rejects, or null when nothing was
 * rejected. Ties break toward the earlier reason in `LEG_REJECT_REASONS` so the
 * label is stable across runs with identical inputs.
 */
export function dominantRejectReason(
  summary: LegScreenSummary,
): LegRejectReason | null {
  let best: LegRejectReason | null = null;
  let bestCount = 0;
  for (const reason of LEG_REJECT_REASONS) {
    if (summary.rejects[reason] > bestCount) {
      best = reason;
      bestCount = summary.rejects[reason];
    }
  }
  return best;
}
