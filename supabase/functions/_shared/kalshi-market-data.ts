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
    const orderbook = (await response.json()) as Orderbook;
    return { ok: true, orderbook };
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
