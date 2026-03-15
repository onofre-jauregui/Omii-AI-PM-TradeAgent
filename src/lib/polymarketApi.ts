import { supabase } from "@/integrations/supabase/client";

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  volume: number;
  volume24hr: number;
  liquidity: number;
  startDate: string;
  endDate: string;
  markets: PolymarketMarket[];
  competitive?: number;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  description: string;
  outcomePrices: string;
  volume: number;
  volume24hr: number;
  liquidity: number;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  groupItemTitle?: string;
  enableOrderBook?: boolean;
}

export interface ParsedMarket {
  id: string;
  question: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  volume24hr: number;
  liquidity: number;
  endDate: string;
  category: string;
  slug: string;
  active: boolean;
}

function parseOutcomePrices(raw: string): { yes: number; no: number } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return { yes: Math.round(parseFloat(parsed[0]) * 100), no: Math.round(parseFloat(parsed[1]) * 100) };
    }
  } catch {}
  return { yes: 50, no: 50 };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "TBD";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(0)}K`;
  return `$${vol.toFixed(0)}`;
}

export async function fetchPolymarketEvents(limit = 20, tag?: string): Promise<ParsedMarket[]> {
  const params: Record<string, string> = { endpoint: "events", limit: String(limit) };
  if (tag) params.tag = tag;

  const { data, error } = await supabase.functions.invoke("polymarket-proxy", {
    body: null,
    headers: {},
  });

  // Use query params via URL
  const url = new URL(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/polymarket-proxy`);
  url.searchParams.set("endpoint", "events");
  url.searchParams.set("limit", String(limit));
  if (tag) url.searchParams.set("tag", tag);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
  });

  if (!response.ok) throw new Error("Failed to fetch markets");

  const events: PolymarketEvent[] = await response.json();

  const markets: ParsedMarket[] = [];
  for (const event of events) {
    if (event.markets && event.markets.length > 0) {
      for (const market of event.markets) {
        const prices = parseOutcomePrices(market.outcomePrices || "[]");
        markets.push({
          id: market.id,
          question: market.question || event.title,
          description: market.description || event.description || "",
          yesPrice: prices.yes,
          noPrice: prices.no,
          volume: market.volume || event.volume || 0,
          volume24hr: market.volume24hr || event.volume24hr || 0,
          liquidity: market.liquidity || event.liquidity || 0,
          endDate: formatDate(market.endDate || event.endDate),
          category: "Prediction",
          slug: market.slug || event.slug,
          active: market.active,
        });
      }
    }
  }

  return markets;
}

export { formatVolume, formatDate };
