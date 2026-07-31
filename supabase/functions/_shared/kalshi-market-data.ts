/**
 * Public (unauthenticated) Kalshi market-data reads. No Deno/Supabase imports
 * beyond a base-URL lookup — kept separate from kalshi-signing.ts because these
 * endpoints need no request signing at all.
 */

export interface OrderbookLevel {
  price: number;
  quantity?: number;
  count?: number;
}

export interface OrderbookSide {
  asks?: OrderbookLevel[];
  bids?: OrderbookLevel[];
}

export interface Orderbook {
  yes?: OrderbookSide;
  no?: OrderbookSide;
}

export type FetchOrderbookResult =
  | { ok: true; orderbook: Orderbook }
  | { ok: false; tickerGone: boolean; status: number | null; error?: string };

// Same 8s bound as the CREDENTIAL_FETCH_TIMEOUT_MS/KALSHI_FETCH_TIMEOUT_MS
// convention used across market-data-fetcher/auto-trade/settle-signals/etc —
// a public market-data GET, not an LLM call.
const ORDERBOOK_FETCH_TIMEOUT_MS = 8_000;

/** Raw shape of GET /markets/{ticker}/orderbook — confirmed against a live
 *  request (2026-07-31) and against Kalshi's own docs
 *  (docs.kalshi.com/api-reference/market/get-market-orderbook): each level is
 *  [price_dollars_string, contract_count_string]. There is no separate ask
 *  field — Kalshi's book only carries resting BIDS on each side; a yes bid at
 *  price P is economically identical to a no ask at (100-P) and vice versa. */
interface RawOrderbookFp {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

function parseLevels(raw: [string, string][] | undefined): OrderbookLevel[] {
  if (!raw) return [];
  return raw.map(([priceDollars, count]) => ({
    price: Math.round(Number(priceDollars) * 100),
    quantity: Number(count),
  }));
}

/** Mirror bid levels on one side into ask levels on the other: a bid to buy
 *  X at price P is the same resting interest as an ask to sell the opposite
 *  contract at (100-P), same size. */
function mirrorAsks(bids: OrderbookLevel[]): OrderbookLevel[] {
  return bids.map(level => ({ price: 100 - level.price, quantity: level.quantity }));
}

/** Converts Kalshi's real API response (orderbook_fp.{yes,no}_dollars, bids
 *  only) into the internal Orderbook shape (yes/no × asks/bids) that
 *  fill-sim.ts's depth math consumes. Previously fetchOrderbook cast the raw
 *  response straight to `Orderbook` with no transformation — since the real
 *  API has no top-level `yes`/`no` keys at all (everything lives under
 *  `orderbook_fp`), `orderbook.yes`/`orderbook.no` were always `undefined`
 *  for every real request, so every paper-trade fill simulation and every
 *  live pre-trade liquidity check has been walking an empty book regardless
 *  of real market depth. Verified directly against a live request during the
 *  2026-07-31 integration-test pass — this was never caught because
 *  fill-sim.test.ts's fixtures hand-construct the internal shape directly
 *  rather than parsing a real API response.
 */
export function parseKalshiOrderbook(raw: unknown): Orderbook {
  const orderbookFp = (raw as RawOrderbookFp)?.orderbook_fp ?? {};
  const yesBids = parseLevels(orderbookFp.yes_dollars);
  const noBids = parseLevels(orderbookFp.no_dollars);
  return {
    yes: { bids: yesBids, asks: mirrorAsks(noBids) },
    no: { bids: noBids, asks: mirrorAsks(yesBids) },
  };
}

/**
 * Real-time public orderbook read for a single ticker. 404/410 mean the
 * market doesn't exist or was delisted (e.g. a bracket rolled out of the
 * strike ladder) — every other failure is transient (network/5xx/malformed
 * body). `error` carries the raw exception message on that path so callers
 * can log it instead of the failure being indistinguishable from a delisting.
 */
export async function fetchOrderbook(
  kalshiBase: string,
  ticker: string
): Promise<FetchOrderbookResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORDERBOOK_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${kalshiBase}/markets/${ticker}/orderbook`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        tickerGone: response.status === 404 || response.status === 410,
        status: response.status,
      };
    }
    const raw = await response.json();
    return { ok: true, orderbook: parseKalshiOrderbook(raw) };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      tickerGone: false,
      status: null,
      error: isTimeout
        ? `Orderbook request timed out after ${ORDERBOOK_FETCH_TIMEOUT_MS}ms: ${ticker}`
        : err instanceof Error
        ? err.message
        : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
