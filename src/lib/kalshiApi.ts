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
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
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

function formatVolume(vol: number | string): string {
  const v = Number(vol) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

const proxyUrl = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kalshi-proxy`;
const authHeader = () => ({
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
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

  return markets.map((m) => ({
    id: m.ticker,
    ticker: m.ticker,
    question: m.title || m.subtitle,
    description: m.subtitle || "",
    yesPrice: Math.round((m.yes_bid + m.yes_ask) / 2 * 100) || Math.round(m.last_price * 100),
    noPrice: Math.round((m.no_bid + m.no_ask) / 2 * 100) || (100 - Math.round(m.last_price * 100)),
    yesBid: Math.round(m.yes_bid * 100),
    yesAsk: Math.round(m.yes_ask * 100),
    noBid: Math.round(m.no_bid * 100),
    noAsk: Math.round(m.no_ask * 100),
    volume: m.volume || 0,
    volume24hr: m.volume_24h || 0,
    liquidity: m.liquidity || m.open_interest || 0,
    openInterest: m.open_interest || 0,
    endDate: formatDate(m.close_time || m.expiration_time),
    closeTime: m.close_time || m.expiration_time || "",
    category: m.category || "Event",
    slug: m.ticker,
    active: m.status === "open",
    spread: Math.round((m.yes_ask - m.yes_bid) * 100),
  }));
}

export async function fetchKalshiMarket(ticker: string): Promise<ParsedMarket | null> {
  const data = await kalshiProxyGet(`markets/${ticker}`);
  const m = data.market;
  if (!m) return null;
  return {
    id: m.ticker,
    ticker: m.ticker,
    question: m.title || m.subtitle,
    description: m.subtitle || "",
    yesPrice: Math.round((m.yes_bid + m.yes_ask) / 2 * 100),
    noPrice: Math.round((m.no_bid + m.no_ask) / 2 * 100),
    yesBid: Math.round(m.yes_bid * 100),
    yesAsk: Math.round(m.yes_ask * 100),
    noBid: Math.round(m.no_bid * 100),
    noAsk: Math.round(m.no_ask * 100),
    volume: m.volume || 0,
    volume24hr: m.volume_24h || 0,
    liquidity: m.liquidity || m.open_interest || 0,
    openInterest: m.open_interest || 0,
    endDate: formatDate(m.close_time || m.expiration_time),
    closeTime: m.close_time || m.expiration_time || "",
    category: m.category || "Event",
    slug: m.ticker,
    active: m.status === "open",
    spread: Math.round((m.yes_ask - m.yes_bid) * 100),
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
        allMarkets.push({
          id: m.ticker,
          ticker: m.ticker,
          question: m.title || event.title,
          description: m.subtitle || event.sub_title || "",
          yesPrice: Math.round((m.yes_bid + m.yes_ask) / 2 * 100),
          noPrice: Math.round((m.no_bid + m.no_ask) / 2 * 100),
          yesBid: Math.round(m.yes_bid * 100),
          yesAsk: Math.round(m.yes_ask * 100),
          noBid: Math.round(m.no_bid * 100),
          noAsk: Math.round(m.no_ask * 100),
          volume: m.volume || 0,
          volume24hr: m.volume_24h || 0,
          liquidity: m.liquidity || m.open_interest || 0,
          openInterest: m.open_interest || 0,
          endDate: formatDate(m.close_time || m.expiration_time),
          closeTime: m.close_time || m.expiration_time || "",
          category: m.category || event.category || "Event",
          slug: m.ticker,
          active: m.status === "open",
          spread: Math.round((m.yes_ask - m.yes_bid) * 100),
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
