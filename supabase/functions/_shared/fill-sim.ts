/**
 * Pure fill/fee simulation logic. No Deno/Supabase imports — safe under both
 * Deno edge functions and Vitest. Used by execute-trade's paper branch and by
 * checkLiquidity's live pre-check (same real-orderbook-depth math, one code
 * path) and by paper-reconcile (re-simulating a resting paper order over time).
 */

import type { Orderbook } from "./kalshi-market-data.ts";

export interface DepthResult {
  availableContracts: number;
  contractsNeeded: number;
  sufficient: boolean;
}

function pickBookSide(
  orderbook: Orderbook,
  side: "yes" | "no",
  action: "buy" | "sell"
) {
  return side === "yes"
    ? action === "buy"
      ? orderbook.yes?.asks
      : orderbook.yes?.bids
    : action === "buy"
      ? orderbook.no?.asks
      : orderbook.no?.bids;
}

function levelPriceCents(level: { price: number }): number {
  return level.price < 1 ? Math.round(level.price * 100) : level.price;
}

/**
 * Walk the real orderbook and sum depth at-or-better-than `price` (cents).
 * Extracted verbatim from execute-trade's checkLiquidity so both the live
 * pre-check and paper-fill simulation share identical depth math.
 */
export function computeDepthAtPrice(
  orderbook: Orderbook,
  side: "yes" | "no",
  action: "buy" | "sell",
  price: number,
  amount: number
): DepthResult {
  const book = pickBookSide(orderbook, side, action);
  const priceInDollars = price / 100;
  const contractsNeeded = Math.ceil(amount / priceInDollars);

  if (!book || book.length === 0) {
    return { availableContracts: 0, contractsNeeded, sufficient: false };
  }

  let availableContracts = 0;
  for (const level of book) {
    const p = levelPriceCents(level);
    if (action === "buy" && p <= price) {
      availableContracts += level.quantity ?? level.count ?? 0;
    } else if (action === "sell" && p >= price) {
      availableContracts += level.quantity ?? level.count ?? 0;
    }
  }

  return { availableContracts, contractsNeeded, sufficient: availableContracts >= contractsNeeded };
}

export type PaperFillStatus = "filled" | "partial" | "open";

export interface PaperFillResult {
  status: PaperFillStatus;
  filledPrice: number | null; // depth-weighted average of consumed real levels, cents
  filledContracts: number;
  requestedContracts: number;
  slippageCents: number | null; // filledPrice - requestedPrice
}

/**
 * Simulate how a paper order placed against the REAL Kalshi orderbook right
 * now would fill — walking the same real price levels a live limit order
 * would rest against. amount is USD notional; price/action/side match
 * execute-trade's contract. Levels at-or-better-than `price` are consumed
 * cumulatively, best price first, up to the requested size — mirroring how
 * a resting limit order actually executes against a real book.
 */
export function simulatePaperFill(
  orderbook: Orderbook,
  side: "yes" | "no",
  action: "buy" | "sell",
  price: number,
  amount: number
): PaperFillResult {
  const book = pickBookSide(orderbook, side, action);
  const priceInDollars = price / 100;
  const requestedContracts = Math.ceil(amount / priceInDollars);

  const eligible = (book ?? [])
    .map((level) => ({ price: levelPriceCents(level), qty: level.quantity ?? level.count ?? 0 }))
    .filter((level) => (action === "buy" ? level.price <= price : level.price >= price))
    .sort((a, b) => (action === "buy" ? a.price - b.price : b.price - a.price));

  let remaining = requestedContracts;
  let costCents = 0;
  let filledContracts = 0;
  for (const level of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.qty);
    if (take <= 0) continue;
    costCents += take * level.price;
    filledContracts += take;
    remaining -= take;
  }

  const filledPrice = filledContracts > 0 ? Math.round(costCents / filledContracts) : null;
  const slippageCents = filledPrice != null ? filledPrice - price : null;
  const status: PaperFillStatus =
    filledContracts >= requestedContracts ? "filled" : filledContracts > 0 ? "partial" : "open";

  return { status, filledPrice, filledContracts, requestedContracts, slippageCents };
}

/**
 * Kalshi's published trading fee: taker = round_up(0.07 * contracts * P * (1-P))
 * cents total, where P is the price as a fraction of $1 (e.g. 62c -> 0.62);
 * maker (resting order, not immediately crossing) = 25% of the taker fee.
 * Peaks at 1.75c/contract at 50c, shrinks toward the extremes (1c/99c).
 *
 * Verified against Kalshi's published fee schedule as of 2026-07 — re-check
 * against kalshi.com/fee-schedule before this estimate is relied on for a
 * production promotion, since Kalshi can revise the schedule.
 *
 * Used only to ESTIMATE paper fees (no real order exists to read a fee from).
 * Live trades capture Kalshi's own reported maker_fees_dollars/
 * taker_fees_dollars from the real order response instead — zero formula risk.
 */
export function estimateKalshiFee(
  priceCents: number,
  contracts: number,
  isMaker: boolean
): number {
  if (contracts <= 0) return 0;
  const p = priceCents / 100;
  const takerFeeDollars = 0.07 * contracts * p * (1 - p);
  const feeDollars = isMaker ? takerFeeDollars * 0.25 : takerFeeDollars;
  return Math.ceil(feeDollars * 100); // round up to next cent, per Kalshi's convention
}
