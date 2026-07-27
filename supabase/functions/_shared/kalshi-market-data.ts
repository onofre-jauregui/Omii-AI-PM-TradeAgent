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
  try {
    const response = await fetch(`${kalshiBase}/markets/${ticker}/orderbook`);
    if (!response.ok) {
      return {
        ok: false,
        tickerGone: response.status === 404 || response.status === 410,
        status: response.status,
      };
    }
    const orderbook = (await response.json()) as Orderbook;
    return { ok: true, orderbook };
  } catch (err) {
    return {
      ok: false,
      tickerGone: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
