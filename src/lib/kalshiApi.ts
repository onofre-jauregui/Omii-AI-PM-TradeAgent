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
  event_ticker?: string;
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
  eventTicker: string;  // e.g. "KXFED-27APR" — used for Kalshi website URL
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

// Caps concurrent kalshi-proxy GET requests. Category tabs, background pre-warm,
// and per-series trending fan-out can each fire a dozen+ requests independently —
// with no cap they stack up over a session and exhaust the browser's connection
// pool (net::ERR_INSUFFICIENT_RESOURCES), starving unrelated fetches on the page.
const MAX_CONCURRENT_PROXY_REQUESTS = 6;
let activeProxyRequests = 0;
const proxyRequestQueue: Array<() => void> = [];

function acquireProxySlot(): Promise<void> {
  return new Promise(resolve => {
    const tryGrant = () => {
      if (activeProxyRequests < MAX_CONCURRENT_PROXY_REQUESTS) {
        activeProxyRequests++;
        resolve();
      } else {
        proxyRequestQueue.push(tryGrant);
      }
    };
    tryGrant();
  });
}

function releaseProxySlot(): void {
  activeProxyRequests--;
  const next = proxyRequestQueue.shift();
  if (next) next();
}

async function kalshiProxyGet(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(proxyUrl());
  url.searchParams.set("endpoint", endpoint);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  await acquireProxySlot();
  try {
    const response = await fetch(url.toString(), { headers: authHeader() });
    if (!response.ok) throw new Error(`Kalshi API error: ${response.status}`);
    return response.json();
  } finally {
    releaseProxySlot();
  }
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

// Curated series for Trending — one representative per category.
// Only 1–2 markets are taken from each series so the feed shows variety, not
// 15 "Bitcoin at $X" price levels.
const TRENDING_CURATED: Array<{ ticker: string; category: string }> = [
  { ticker: "KXINX",       category: "Financials" },
  { ticker: "KXBTC",       category: "Crypto"     },
  { ticker: "KXFED",       category: "Economics"  },
  { ticker: "KXCPI",       category: "Economics"  },
  { ticker: "KXETH",       category: "Crypto"     },
  { ticker: "KXNBA",       category: "Sports"     },
  { ticker: "KXMLB",       category: "Sports"     },
  { ticker: "KXNHL",       category: "Sports"     },
  { ticker: "KXPAYROLLS",  category: "Economics"  },
  { ticker: "KXGDP",       category: "Economics"  },
];

// Categories not covered by curated series — fetched dynamically to add variety
const TRENDING_VARIETY_CATEGORIES = [
  "Elections", "Politics", "Companies", "Culture", "Commodities", "Climate",
];

// Known active Kalshi series — these return real event-contract markets
// (not MVE parlays). The default /markets endpoint is 100% MVE parlays.
const KALSHI_ACTIVE_SERIES = [
  "KXFED",       // Federal Reserve rate decisions (most liquid ~50¢)
  "KXGDP",       // US GDP growth (very liquid ~50¢)
  "KXPAYROLLS",  // Monthly jobs report
  "KXCPI",       // CPI inflation data
  "KXINX",       // S&P 500 price range
  "KXBTC",       // Bitcoin price range
  "KXETH",       // Ethereum price range
  "KXNHL",       // NHL hockey
  "KXNBA",       // NBA basketball
  "KXMLB",       // MLB baseball
  "KXCHCUTS",    // Challenger job cuts
];

function parseKalshiMarket(m: KalshiMarket): ParsedMarket | null {
  // Explicitly skip MVE multi-leg parlay markets
  if ((m.ticker || "").startsWith("KXMVE")) return null;

  const _ya   = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
  const _yb   = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
  const _nb   = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
  const _last = Number(m.last_price_dollars ?? m.last_price) || 0;

  // Require at least a real YES quote or last price (0.5¢ threshold)
  const hasRealYes  = (_ya >= 0.005 && _ya < 0.999) || _yb >= 0.005;
  const hasRealLast = _last >= 0.005 && _last < 0.995;
  const hasRealNo   = _nb >= 0.005 && _nb < 0.97;
  if (!hasRealYes && !hasRealLast && !hasRealNo) return null;

  const yesBid = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
  const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
  const noBid  = Number(m.no_bid_dollars  ?? m.no_bid)  || 0;
  const noAsk  = Number(m.no_ask_dollars  ?? m.no_ask)  || 0;
  const last   = Number(m.last_price_dollars ?? m.last_price) || 0;
  const { yes: yesPrice, no: noPrice } = resolvePrice(yesBid, yesAsk, noBid, noAsk, last);

  // Combine title + subtitle so strike-price markets are distinguishable
  // e.g. "Ethereum price at Apr 6 at 3pm EDT? — $2,740 or above"
  const titleStr = m.title || "";
  const subtitleStr = m.subtitle || "";
  const question = titleStr && subtitleStr && subtitleStr !== titleStr
    ? `${titleStr} — ${subtitleStr}`
    : titleStr || subtitleStr;

  return {
    id: m.ticker,
    ticker: m.ticker,
    eventTicker: m.event_ticker || m.ticker,
    question,
    description: subtitleStr,
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

/**
 * Fetch markets from known active Kalshi series in parallel.
 * The default /markets endpoint returns only MVE parlay markets, so we
 * target specific series where real event contracts trade.
 */
export async function fetchKalshiMarkets(
  _limit = 50,
  _cursor?: string,
  extraParams: Record<string, string> = {}
): Promise<ParsedMarket[]> {
  const seriesTicker = extraParams.series_ticker;

  if (seriesTicker) {
    // Single-series fetch (used by category filter)
    const data = await kalshiProxyGet("markets", { limit: "50", status: "open", ...extraParams });
    return (data.markets || []).map(parseKalshiMarket).filter((m): m is ParsedMarket => m !== null);
  }

  // Parallel fetch across all known active series
  const results = await Promise.allSettled(
    KALSHI_ACTIVE_SERIES.map(s =>
      kalshiProxyGet("markets", { limit: "20", status: "open", series_ticker: s })
        .then(d => (d.markets || []) as KalshiMarket[])
        .catch(() => [] as KalshiMarket[])
    )
  );

  const seen = new Set<string>();
  const allMarkets: ParsedMarket[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const raw of result.value) {
      if (seen.has(raw.ticker)) continue;
      seen.add(raw.ticker);
      const parsed = parseKalshiMarket(raw);
      if (parsed) allMarkets.push(parsed);
    }
  }

  // Sort by volume descending so most-liquid markets come first
  return allMarkets.sort((a, b) => b.volume - a.volume);
}

/**
 * Fetch the single highest-volume active market from a given category.
 * Used by buildTrendingFeed to sample variety categories not in TRENDING_CURATED.
 * Two sequential requests: series discovery → top market.
 */
async function fetchTopFromCategory(category: string): Promise<ParsedMarket | null> {
  const apiCategory = CATEGORY_API_NAME[category] ?? category;
  try {
    const seriesData = await kalshiProxyGet("series", {
      status: "active", category: apiCategory, limit: "3",
    });
    const series: string[] = (seriesData.series ?? []).map((s: any) => s.ticker).filter(Boolean);
    if (!series.length) return null;
    const mkData = await kalshiProxyGet("markets", {
      series_ticker: series[0], status: "open", limit: "5",
    });
    const parsed = (mkData.markets || [] as KalshiMarket[])
      .map(parseKalshiMarket)
      .filter((m): m is ParsedMarket => m !== null)
      .sort((a, b) => b.volume - a.volume);
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

export async function fetchKalshiMarket(ticker: string): Promise<ParsedMarket | null> {
  const data = await kalshiProxyGet(`markets/${ticker}`);
  const m = data.market;
  if (!m) return null;
  return parseKalshiMarket(m);
}

export async function fetchKalshiEvents(limit = 20): Promise<ParsedMarket[]> {
  // Note: Kalshi /events endpoint does NOT return nested markets.
  // Use fetchKalshiMarkets() instead, which fetches from active series.
  return fetchKalshiMarkets(limit);
}

// ─── Series Discovery ────────────────────────────────────────

export interface KalshiSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: string;
}

export async function fetchKalshiSeries(limit = 200): Promise<KalshiSeries[]> {
  const data = await kalshiProxyGet("series", { status: "active", limit: String(limit) });
  return (data.series ?? []).map((s: any) => ({
    ticker: s.ticker,
    title: s.title ?? s.ticker,
    category: s.category ?? "Other",
    frequency: s.frequency ?? "singular",
  }));
}

// Maps our display tab names → Kalshi API category strings
const CATEGORY_API_NAME: Record<string, string> = {
  "Culture":       "Entertainment",
  "Climate":       "Climate and Weather",
  "Tech & Science":"Science and Technology",
  // All others match 1:1: Elections, Politics, Sports, Crypto,
  // Commodities, Economics, Companies, Financials, Mentions
};

export async function fetchKalshiMarketsByCategory(
  _allSeries: KalshiSeries[], // kept for API compat — no longer used
  category: string,
  limitPerSeries = 10
): Promise<ParsedMarket[]> {
  // Trending: one representative pick per series + one from each variety category.
  // Runs in two parallel phases so the total wall-clock time is ~2 round trips,
  // not 11+ sequential. Each series contributes at most 1 market to prevent
  // "BTC at $80k / BTC at $82.5k / BTC at $85k" repetition.
  if (category === "Trending") {
    const [curatedResults, varietyResults] = await Promise.all([
      // Phase 1: known series (fast — no series-discovery step needed)
      Promise.allSettled(
        TRENDING_CURATED.map(({ ticker: s }) =>
          kalshiProxyGet("markets", { limit: "3", status: "open", series_ticker: s })
            .then(d => (d.markets || []) as KalshiMarket[])
            .catch(() => [] as KalshiMarket[])
        )
      ),
      // Phase 2: dynamic categories not in curated list (2-request chain per category)
      Promise.allSettled(
        TRENDING_VARIETY_CATEGORIES.map(cat => fetchTopFromCategory(cat))
      ),
    ]);

    const seen = new Set<string>();
    const trending: ParsedMarket[] = [];

    // Top 1 market per curated series (preserves category diversity)
    for (const result of curatedResults) {
      if (result.status !== "fulfilled") continue;
      const best = result.value
        .map(parseKalshiMarket)
        .filter((m): m is ParsedMarket => m !== null)
        .sort((a, b) => b.volume - a.volume)[0];
      if (best && !seen.has(best.ticker)) {
        seen.add(best.ticker);
        trending.push(best);
      }
    }

    // Top 1 market per variety category
    for (const result of varietyResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const m = result.value;
      if (!seen.has(m.ticker)) {
        seen.add(m.ticker);
        trending.push(m);
      }
    }

    return trending.sort((a, b) => b.volume - a.volume);
  }

  // Resolve our display name to Kalshi's API category name
  const apiCategory = CATEGORY_API_NAME[category] ?? category;

  // Fetch up to 12 active series for this category — more than this adds latency with little benefit
  let seriesList: KalshiSeries[] = [];
  try {
    const data = await kalshiProxyGet("series", {
      status: "active",
      category: apiCategory,
      limit: "12",
    });
    seriesList = (data.series ?? []).map((s: any) => ({
      ticker: s.ticker ?? "",
      title: s.title ?? s.ticker ?? "",
      category: s.category ?? apiCategory,
      frequency: s.frequency ?? "singular",
    }));
  } catch {
    return [];
  }

  if (seriesList.length === 0) return [];

  // Fetch markets from each series in parallel
  const results = await Promise.allSettled(
    seriesList.map(s =>
      kalshiProxyGet("markets", { series_ticker: s.ticker, status: "open", limit: String(limitPerSeries) })
        .then(d => (d.markets ?? []) as KalshiMarket[])
        .catch(() => [] as KalshiMarket[])
    )
  );

  const seen = new Set<string>();
  const markets: ParsedMarket[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const raw of result.value) {
      if (seen.has(raw.ticker)) continue;
      seen.add(raw.ticker);
      const parsed = parseKalshiMarket(raw);
      if (parsed) markets.push(parsed);
    }
  }

  return markets.sort((a, b) => b.volume - a.volume);
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
