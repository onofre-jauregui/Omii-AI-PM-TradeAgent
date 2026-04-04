// Kalshi API client for the frontend — proxied through Supabase edge functions
// Kalshi REST API v2: https://trading-api.kalshi.com/trade-api/v2

export interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  sub_title: string;
  mutually_exclusive: boolean;
  markets: KalshiMarket[];
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  last_price_dollars?: string | number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  liquidity: number;
  status: string;
  close_time: string;
  expiration_time: string;
  result: string;
  category: string;
}

export interface ParsedMarket {
  id: string;
  ticker: string;
  question: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  volume: number;
  volume24hr: number;
  liquidity: number;
  openInterest: number;
  endDate: string;     // formatted display string e.g. "Jul 1, 2026"
  closeTime: string;   // raw ISO timestamp for filtering
  category: string;
  slug: string;
  active: boolean;
  spread: number;
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  yes_price: number;
  no_price: number;
  count: number;
  remaining_count: number;
  status: string;
  created_time: string;
  expiration_time: string;
}

export interface KalshiPosition {
  ticker: string;
  market_title: string;
  count: number;
  avg_price: number;
  side: "yes" | "no";
  market_result: string;
  realized_pnl: number;
}

export interface KalshiBalance {
  balance: number;
  portfolio_value: number;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "TBD";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/** Compute a display price in cents (0-99) from Kalshi bid/ask/last dollar values.
 *  - Uses midpoint when both sides exist and ask < ceiling (1.0)
 *  - Falls back to ask (for YES) or bid (for NO) when the other side is missing
 *  - Derives from the opposite side when own prices are absent */
function resolvePrice(bid: number, ask: number, oppositeBid: number, oppositeAsk: number, last: number): { yes: number; no: number } {
  // YES: use mid when bid > 0, otherwise fall back to ask price
  // YES: treat ask<0.5¢ or ≥100c as non-quote (ceiling/sub-cent placeholder)
  const realAsk = ask >= 0.005 && ask < 0.999 ? ask : 0;
  const yesMid = bid > 0 && realAsk > 0
    ? Math.round((bid + realAsk) / 2 * 100)
    : realAsk > 0 ? Math.round(realAsk * 100) : 0;

  // NO: filter out ceiling placeholders on bid side too (no_bid = 1.0 is not a real quote)
  const realNoBid = oppositeBid >= 0.005 && oppositeBid < 0.999 ? oppositeBid : 0;
  const noMid = realNoBid > 0 && oppositeAsk > 0 && oppositeAsk < 0.999
    ? Math.round((realNoBid + oppositeAsk) / 2 * 100)
    : realNoBid > 0 ? Math.round(realNoBid * 100) : 0;

  const lastCents = last > 0 ? Math.round(last * 100) : 0;

  const yes = yesMid || (noMid > 0 ? 100 - noMid : 0) || lastCents;
  const no  = noMid  || (yesMid > 0 ? 100 - yesMid : 0) || (lastCents > 0 ? 100 - lastCents : 0);
  return { yes, no };
}

function formatVolume(vol: number | string): string {
  const v = Number(vol) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

const proxyUrl = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kalshi-proxy`;
const authHeader = () => ({
  Authorization: `Bearer ${(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim()}`,
  "Content-Type": "application/json",
});

async function kalshiProxyGet(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(proxyUrl());
  url.searchParams.set("endpoint", endpoint);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), { headers: authHeader() });
  if (!response.ok) throw new Error(`Kalshi API error: ${response.status}`);
  return response.json();
}

async function kalshiProxyPost(endpoint: string, body: any): Promise<any> {
  const url = new URL(proxyUrl());
  url.searchParams.set("endpoint", endpoint);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `Kalshi API error: ${response.status}`);
  }
  return response.json();
}

async function kalshiProxyDelete(endpoint: string): Promise<any> {
  const url = new URL(proxyUrl());
  url.searchParams.set("endpoint", endpoint);
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: authHeader(),
  });
  if (!response.ok) throw new Error(`Kalshi API error: ${response.status}`);
  return response.json();
}

// ─── Market Data ─────────────────────────────────────────────

export async function fetchKalshiMarkets(
  limit = 50,
  cursor?: string,
  extraParams: Record<string, string> = {}
): Promise<ParsedMarket[]> {
  const params: Record<string, string> = { limit: String(limit), status: "open", ...extraParams };
  if (cursor) params.cursor = cursor;

  const data = await kalshiProxyGet("markets", params);
  const markets: KalshiMarket[] = data.markets || [];

  return markets.map((m) => {
    // Skip markets with no real price data (unstarted/illiquid MVE parlays)
    const _ya = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
    const _yb = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
    const _nb = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
    const _last = Number(m.last_price_dollars ?? m.last_price) || 0;
    // Minimum 0.5¢ threshold so sub-cent values don't round to 0c display
    const hasRealYes  = (_ya >= 0.005 && _ya < 0.999) || _yb >= 0.005;
    const hasRealNo   = _nb >= 0.005 && _nb < 0.995;
    const hasRealLast = _last >= 0.005 && _last < 0.995;
    // Require at least a real YES quote OR last price; don't show markets with ONLY a near-100c NO bid
    const hasPrice = hasRealYes || hasRealLast || (hasRealNo && _nb < 0.97);
    if (!hasPrice) return null;
    const yesBid = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
    const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
    const noBid  = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
    const noAsk  = Number(m.no_ask_dollars  ?? m.no_ask)  || 0;
    const last   = Number(m.last_price_dollars ?? m.last_price) || 0;

    const { yes: yesPrice, no: noPrice } = resolvePrice(yesBid, yesAsk, noBid, noAsk, last);

    return ({
    id: m.ticker,
    ticker: m.ticker,
    question: m.title || m.subtitle,
    description: m.subtitle || "",
    yesPrice,
    noPrice,
    yesBid: Math.round(yesBid * 100),
    yesAsk: Math.round(yesAsk * 100),
    noBid:  Math.round(noBid  * 100),
    noAsk:  Math.round(noAsk  * 100),
    volume: m.volume || 0,
    volume24hr: m.volume_24h || 0,
    liquidity: m.liquidity || m.open_interest || 0,
    openInterest: m.open_interest || 0,
    endDate: formatDate(m.close_time || m.expiration_time),
    closeTime: m.close_time || m.expiration_time || "",
    category: m.category || "Event",
    slug: m.ticker,
    active: m.status === "open",
    spread: yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : 0,
  });
  }).filter((m): m is ParsedMarket => m !== null);
}

export async function fetchKalshiMarket(ticker: string): Promise<ParsedMarket | null> {
  const data = await kalshiProxyGet(`markets/${ticker}`);
  const m = data.market;
  if (!m) return null;
  const yesBid = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
  const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
  const noBid  = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
  const noAsk  = Number(m.no_ask_dollars  ?? m.no_ask)  || 0;
  const last   = Number(m.last_price_dollars ?? m.last_price) || 0;
  const { yes: yesPrice, no: noPrice } = resolvePrice(yesBid, yesAsk, noBid, noAsk, last);
  return {
    id: m.ticker,
    ticker: m.ticker,
    question: m.title || m.subtitle,
    description: m.subtitle || "",
    yesPrice,
    noPrice,
    yesBid: Math.round(yesBid * 100),
    yesAsk: Math.round(yesAsk * 100),
    noBid:  Math.round(noBid  * 100),
    noAsk:  Math.round(noAsk  * 100),
    volume: m.volume || 0,
    volume24hr: m.volume_24h || 0,
    liquidity: m.liquidity || m.open_interest || 0,
    openInterest: m.open_interest || 0,
    endDate: formatDate(m.close_time || m.expiration_time),
    closeTime: m.close_time || m.expiration_time || "",
    category: m.category || "Event",
    slug: m.ticker,
    active: m.status === "open",
    spread: yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : 0,
  };
}

export async function fetchKalshiEvents(limit = 20): Promise<ParsedMarket[]> {
  const params: Record<string, string> = { limit: String(limit), status: "open" };
  const data = await kalshiProxyGet("events", params);
  const events: KalshiEvent[] = data.events || [];

  const allMarkets: ParsedMarket[] = [];
  for (const event of events) {
    if (event.markets) {
      for (const m of event.markets) {
        const yesBid = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
        const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
        const noBid  = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
        const noAsk  = Number(m.no_ask_dollars  ?? m.no_ask)  || 0;
        const last   = Number(m.last_price_dollars ?? m.last_price) || 0;
        const { yes: yesPrice, no: noPrice } = resolvePrice(yesBid, yesAsk, noBid, noAsk, last);
        allMarkets.push({
          id: m.ticker,
          ticker: m.ticker,
          question: m.title || event.title,
          description: m.subtitle || event.sub_title || "",
          yesPrice,
          noPrice,
          yesBid: Math.round(yesBid * 100),
          yesAsk: Math.round(yesAsk * 100),
          noBid:  Math.round(noBid  * 100),
          noAsk:  Math.round(noAsk  * 100),
          volume: m.volume || 0,
          volume24hr: m.volume_24h || 0,
          liquidity: m.liquidity || m.open_interest || 0,
          openInterest: m.open_interest || 0,
          endDate: formatDate(m.close_time || m.expiration_time),
          closeTime: m.close_time || m.expiration_time || "",
          category: m.category || event.category || "Event",
          slug: m.ticker,
          active: m.status === "open",
          spread: yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : 0,
        });
      }
    }
  }
  return allMarkets;
}

// ─── Portfolio & Orders ──────────────────────────────────────

export async function fetchKalshiBalance(): Promise<KalshiBalance> {
  return kalshiProxyGet("portfolio/balance");
}

export async function fetchKalshiPositions(): Promise<KalshiPosition[]> {
  const data = await kalshiProxyGet("portfolio/positions");
  return data.market_positions || [];
}

export async function fetchKalshiOrders(status?: string): Promise<KalshiOrder[]> {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  const data = await kalshiProxyGet("portfolio/orders", params);
  return data.orders || [];
}

export async function fetchKalshiFills(limit = 50): Promise<any[]> {
  const data = await kalshiProxyGet("portfolio/fills", { limit: String(limit) });
  return data.fills || [];
}

// ─── Order Placement ─────────────────────────────────────────

export interface PlaceOrderParams {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  count: number;
  yesPrice?: number;  // in cents (1-99)
  noPrice?: number;
  timeInForce?: "gtc" | "ioc" | "day";
  expirationTs?: number;
}

export async function placeKalshiOrder(params: PlaceOrderParams): Promise<KalshiOrder> {
  const data = await kalshiProxyPost("portfolio/orders", params);
  return data.order;
}

export async function cancelKalshiOrder(orderId: string): Promise<void> {
  await kalshiProxyDelete(`portfolio/orders/${orderId}`);
}

export async function cancelAllOrders(ticker?: string): Promise<void> {
  const params: Record<string, string> = {};
  if (ticker) params.ticker = ticker;
  const url = new URL(proxyUrl());
  url.searchParams.set("endpoint", "portfolio/orders");
  if (ticker) url.searchParams.set("ticker", ticker);
  await fetch(url.toString(), {
    method: "DELETE",
    headers: authHeader(),
  });
}

export { formatVolume, formatDate };
