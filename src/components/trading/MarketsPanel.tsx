import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Users, Clock, TrendingUp, BarChart3, Droplets, ExternalLink, RefreshCw, Loader2, Zap, Wallet, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchKalshiMarkets,
  fetchKalshiSeries,
  fetchKalshiMarketsByCategory,
  fetchKalshiMarket,
  formatVolume,
  type ParsedMarket,
  type KalshiSeries,
} from "@/lib/kalshiApi";
import { MOCK_MARKETS } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { TradeModal } from "./TradeModal";

interface AgentSignal {
  ticker: string;
  direction: string | null;
  edge_score: number | null;
  yes_ask: number | null;
  source: string | null;
}

interface OpenPosition {
  ticker: string;
  side: string;
  amount: number;
  strategy_id: string | null;
}

type SortKey = "volume" | "volume24h" | "endDate";

// Kalshi-native categories — order matches their browse page
const FIXED_CATEGORIES = [
  "Trending",
  "Elections",
  "Politics",
  "Sports",
  "Culture",
  "Crypto",
  "Commodities",
  "Climate",
  "Economics",
  "Companies",
  "Financials",
  "Tech & Science",
];

const CATEGORY_THEME: Record<string, { text: string; bg: string; dot: string }> = {
  "Elections":      { text: "text-rose-500",    bg: "bg-rose-500/10",    dot: "bg-rose-500"    },
  "Politics":       { text: "text-orange-500",  bg: "bg-orange-500/10",  dot: "bg-orange-500"  },
  "Sports":         { text: "text-violet-500",  bg: "bg-violet-500/10",  dot: "bg-violet-500"  },
  "Culture":        { text: "text-pink-500",    bg: "bg-pink-500/10",    dot: "bg-pink-500"    },
  "Crypto":         { text: "text-amber-500",   bg: "bg-amber-500/10",   dot: "bg-amber-500"   },
  "Commodities":    { text: "text-yellow-600",  bg: "bg-yellow-500/10",  dot: "bg-yellow-500"  },
  "Climate":        { text: "text-sky-500",     bg: "bg-sky-500/10",     dot: "bg-sky-500"     },
  "Economics":      { text: "text-indigo-500",  bg: "bg-indigo-500/10",  dot: "bg-indigo-500"  },
  "Federal Reserve":{ text: "text-blue-500",    bg: "bg-blue-500/10",    dot: "bg-blue-500"    },
  "Companies":      { text: "text-teal-500",    bg: "bg-teal-500/10",    dot: "bg-teal-500"    },
  "Financials":     { text: "text-emerald-500", bg: "bg-emerald-500/10", dot: "bg-emerald-500" },
  "Tech & Science": { text: "text-cyan-500",    bg: "bg-cyan-500/10",    dot: "bg-cyan-500"    },
  "default":        { text: "text-muted-foreground", bg: "bg-secondary", dot: "bg-muted-foreground" },
};

function getCategoryTheme(category: string) {
  return CATEGORY_THEME[category] ?? CATEGORY_THEME["default"];
}

function isClosingSoon(closeTime: string): boolean {
  if (!closeTime) return false;
  const diff = new Date(closeTime).getTime() - Date.now();
  return diff > 0 && diff < 24 * 3600 * 1000;
}

const HORIZON_OPTIONS = [
  { value: "any",   label: "Any date",       hours: null    },
  { value: "today", label: "Today",          hours: 24      },
  { value: "week",  label: "This week",      hours: 24 * 7  },
  { value: "month", label: "This month",     hours: 24 * 30 },
] as const;

type Horizon = typeof HORIZON_OPTIONS[number]["value"];

interface MarketsPanelProps {
  mode?: "paper" | "live";
  openMarketTicker?: string | null;
  onMarketOpened?: () => void;
}

export function MarketsPanel({ mode = "paper", openMarketTicker, onMarketOpened }: MarketsPanelProps) {
  const [activeCategory, setActiveCategory] = useState<string>("Trending");
  const [allSeries, setAllSeries] = useState<KalshiSeries[]>([]);
  // Cache: category → markets, so switching tabs doesn't re-fetch
  const cache = useRef<Map<string, { markets: ParsedMarket[]; fetchedAt: number }>>(new Map());
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [markets, setMarkets] = useState<ParsedMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("volume");
  const [horizon, setHorizon] = useState<Horizon>("any");
  const [visibleCount, setVisibleCount] = useState(50);

  const [selectedMarket, setSelectedMarket] = useState<ParsedMarket | null>(null);
  const [tradeMarket, setTradeMarket] = useState<ParsedMarket | null>(null);
  const [tradeInitialSide, setTradeInitialSide] = useState<"yes" | "no" | undefined>();

  const [signalMap, setSignalMap] = useState<Map<string, AgentSignal>>(new Map());
  const [positionMap, setPositionMap] = useState<Map<string, OpenPosition>>(new Map());

  // Load DB overlays once
  useEffect(() => {
    async function loadOverlays() {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const [signalsRes, positionsRes] = await Promise.allSettled([
        supabase.from("signals").select("ticker, direction, edge_score, yes_ask, source")
          .gte("created_at", twoHoursAgo).order("created_at", { ascending: false }),
        supabase.from("trades").select("ticker, side, amount, strategy_id")
          .eq("status", "filled").is("settled_at", null).is("exit_reason", null),
      ]);
      if (signalsRes.status === "fulfilled" && signalsRes.value.data) {
        const map = new Map<string, AgentSignal>();
        for (const s of signalsRes.value.data) {
          if (s.ticker && !map.has(s.ticker)) map.set(s.ticker, s as AgentSignal);
        }
        setSignalMap(map);
      }
      if (positionsRes.status === "fulfilled" && positionsRes.value.data) {
        const map = new Map<string, OpenPosition>();
        for (const p of positionsRes.value.data) {
          if (p.ticker) map.set(p.ticker, p as OpenPosition);
        }
        setPositionMap(map);
      }
    }
    loadOverlays();
    const id = setInterval(loadOverlays, 30_000);
    return () => clearInterval(id);
  }, []);

  // allSeries is no longer needed — fetchKalshiMarketsByCategory is self-contained
  // Kept in state to avoid breaking the KalshiSeries type import
  const fetchCategory = useCallback(async (category: string, force = false) => {
    const TTL = 30_000;
    const cached = cache.current.get(category);
    if (!force && cached && Date.now() - cached.fetchedAt < TTL) {
      setMarkets(cached.markets);
      setLastUpdated(new Date(cached.fetchedAt));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await fetchKalshiMarketsByCategory(allSeries, category, 10);
      cache.current.set(category, { markets: result, fetchedAt: Date.now() });
      setMarkets(result);
      setLastUpdated(new Date());
    } catch {
      setError("Live feed unavailable");
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  }, [allSeries]);

  // When active category changes or series list arrives, fetch
  useEffect(() => {
    fetchCategory(activeCategory);

    if (refreshTimer.current) clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(() => fetchCategory(activeCategory, true), 30_000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [activeCategory, fetchCategory]);

  // Background pre-warm: after active tab loads, silently fetch the next 3 tabs
  useEffect(() => {
    const idx = FIXED_CATEGORIES.indexOf(activeCategory);
    const toWarm = FIXED_CATEGORIES.slice(idx + 1, idx + 4);
    let cancelled = false;
    const warmNext = async () => {
      for (const cat of toWarm) {
        if (cancelled) return;
        const cached = cache.current.get(cat);
        if (!cached || Date.now() - cached.fetchedAt > 30_000) {
          // Don't await — fire and forget, stagger by 1s to avoid hammering the proxy
          await new Promise(r => setTimeout(r, 1000));
          if (cancelled) return;
          fetchCategory(cat);
        }
      }
    };
    // Wait for the active tab to likely finish loading before starting background fetches
    const t = setTimeout(warmNext, 2000);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory]);

  // Reset visible count when search or horizon changes
  useEffect(() => { setVisibleCount(50); }, [search, horizon, sortBy]);

  // Open a market by ticker when navigated from agent chat
  useEffect(() => {
    if (!openMarketTicker) return;
    fetchKalshiMarket(openMarketTicker)
      .then(parsed => {
        if (parsed) setSelectedMarket(parsed);
      })
      .catch(() => {})
      .finally(() => onMarketOpened?.());
  }, [openMarketTicker]);

  const filtered = useMemo(() => {
    let list = markets;

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m => m.question.toLowerCase().includes(q) || m.ticker.toLowerCase().includes(q));
    }

    if (horizon !== "any") {
      const def = HORIZON_OPTIONS.find(h => h.value === horizon);
      if (def?.hours) {
        const now = Date.now();
        const cutoff = now + def.hours * 3600 * 1000;
        list = list.filter(m => {
          if (!m.closeTime) return false;
          const t = new Date(m.closeTime).getTime();
          return t > now && t <= cutoff;
        });
      }
    }

    const effectiveSort = horizon !== "any" && sortBy === "volume" ? "endDate" : sortBy;
    return [...list].sort((a, b) => {
      switch (effectiveSort) {
        case "volume":   return b.volume - a.volume;
        case "volume24h": return b.volume24hr - a.volume24hr;
        case "endDate": {
          const at = a.closeTime ? new Date(a.closeTime).getTime() : Infinity;
          const bt = b.closeTime ? new Date(b.closeTime).getTime() : Infinity;
          return at - bt;
        }
        default: return 0;
      }
    });
  }, [markets, search, sortBy, horizon]);

  return (
    <div className="space-y-0 apple-reveal">

      {/* Category tabs — horizontal scroll */}
      <div className="flex items-center overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0 border-b border-border/50 mb-5">
        {FIXED_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => {
              setActiveCategory(cat);
              setSearch("");
              setVisibleCount(50);
            }}
            className={cn(
              "shrink-0 px-4 py-3 text-sm font-medium transition-all duration-150 border-b-2 -mb-px whitespace-nowrap",
              activeCategory === cat
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center gap-2 flex-1 overflow-x-auto scrollbar-none">
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger className="h-9 w-auto shrink-0 rounded-full border border-border bg-card text-sm px-4 gap-1.5">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="volume">Volume</SelectItem>
              <SelectItem value="volume24h">24h Volume</SelectItem>
              <SelectItem value="endDate">Closing Soon</SelectItem>
            </SelectContent>
          </Select>

          <Select value={horizon} onValueChange={(v) => setHorizon(v as Horizon)}>
            <SelectTrigger className="h-9 w-auto shrink-0 rounded-full border border-border bg-card text-sm px-4 gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue placeholder="Timeframe" />
            </SelectTrigger>
            <SelectContent>
              {HORIZON_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Search toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {searchOpen ? (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-8 h-9 w-44 rounded-full border-border bg-card text-sm"
              />
              <button
                onClick={() => { setSearch(""); setSearchOpen(false); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSearchOpen(true)}
              className="h-9 w-9 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <Search className="h-4 w-4" />
            </button>
          )}

          <button
            onClick={() => fetchCategory(activeCategory, true)}
            disabled={loading}
            className="h-9 w-9 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Status line */}
      {error ? (
        <p className="text-xs text-amber-500 mb-3">{error}</p>
      ) : lastUpdated && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-profit opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-profit" />
          </span>
          <span className="text-profit font-medium">Live</span>
          <span>· {lastUpdated.toLocaleTimeString()} · {filtered.length} markets</span>
        </div>
      )}

      {/* Market grid */}
      {loading && markets.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-3 text-sm text-muted-foreground">Loading {activeCategory} markets...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2">
          <span className="text-sm text-muted-foreground">
            {search
              ? `No markets match "${search}"`
              : `No ${activeCategory} markets closing ${HORIZON_OPTIONS.find(h => h.value === horizon)?.label.toLowerCase() ?? ""}.`}
          </span>
          {horizon !== "any" && (
            <button onClick={() => setHorizon("any")} className="text-xs text-primary hover:opacity-70 transition-opacity">
              Show all dates →
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.slice(0, visibleCount).map((market) => (
              <KalshiMarketCard
                key={market.id}
                market={market}
                signal={signalMap.get(market.ticker)}
                position={positionMap.get(market.ticker)}
                onDetail={() => setSelectedMarket(market)}
                onTrade={(side) => { setTradeInitialSide(side); setTradeMarket(market); }}
              />
            ))}
          </div>
          {filtered.length > visibleCount && (
            <button
              onClick={() => setVisibleCount(c => c + 50)}
              className="mt-5 w-full py-3 rounded-2xl border border-border bg-card text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              Show {Math.min(50, filtered.length - visibleCount)} more
              <span className="ml-1.5 text-xs opacity-60">({filtered.length - visibleCount} remaining)</span>
            </button>
          )}
        </>
      )}

      {/* Market detail modal */}
      <Dialog open={!!selectedMarket} onOpenChange={(open) => !open && setSelectedMarket(null)}>
        <DialogContent className="rounded-2xl border-0 apple-shadow max-w-lg p-0 overflow-hidden">
          {selectedMarket && (
            <div className="p-6 space-y-5">
              <DialogHeader>
                <DialogTitle className="text-base font-medium leading-snug pr-6">
                  {selectedMarket.question}
                </DialogTitle>
                <p className="text-xs text-muted-foreground font-mono">{selectedMarket.ticker}</p>
              </DialogHeader>

              <div className="space-y-3">
                <div>
                  <div className="flex justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">Yes</span>
                    <span className="text-lg font-medium text-profit">{selectedMarket.yesPrice}¢</span>
                  </div>
                  <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-profit rounded-full transition-all duration-500" style={{ width: `${selectedMarket.yesPrice}%` }} />
                  </div>
                  {selectedMarket.yesBid > 0 && (
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>Bid: {selectedMarket.yesBid}¢</span>
                      <span>Ask: {selectedMarket.yesAsk}¢</span>
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">No</span>
                    <span className="text-lg font-medium text-loss">{selectedMarket.noPrice}¢</span>
                  </div>
                  <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-loss rounded-full transition-all duration-500" style={{ width: `${selectedMarket.noPrice}%` }} />
                  </div>
                  {selectedMarket.noBid > 0 && (
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>Bid: {selectedMarket.noBid}¢</span>
                      <span>Ask: {selectedMarket.noAsk}¢</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <StatBox icon={BarChart3} label="Total Volume" value={formatVolume(selectedMarket.volume)} />
                <StatBox icon={TrendingUp} label="24h Volume" value={formatVolume(selectedMarket.volume24hr)} />
                <StatBox icon={Droplets} label="Open Interest" value={formatVolume(selectedMarket.openInterest)} />
                <StatBox icon={Clock} label="Closes" value={selectedMarket.endDate} />
              </div>

              {selectedMarket.description && (
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
                  {selectedMarket.description}
                </p>
              )}

              <div className="flex gap-3">
                <Button
                  className="flex-1 h-10 rounded-full text-sm bg-profit/10 text-profit hover:bg-profit/20 border-0"
                  onClick={() => {
                    setTradeInitialSide("yes");
                    setTradeMarket(selectedMarket);
                    setSelectedMarket(null);
                  }}
                >
                  Buy Yes @ {selectedMarket.yesAsk || selectedMarket.yesPrice}¢
                </Button>
                <Button
                  className="flex-1 h-10 rounded-full text-sm bg-loss/10 text-loss hover:bg-loss/20 border-0"
                  onClick={() => {
                    setTradeInitialSide("no");
                    setTradeMarket(selectedMarket);
                    setSelectedMarket(null);
                  }}
                >
                  Buy No @ {selectedMarket.noAsk || selectedMarket.noPrice}¢
                </Button>
              </div>

              {selectedMarket.eventTicker && (
                <a
                  href={`https://kalshi.com/markets/${selectedMarket.eventTicker.toLowerCase()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80 transition-opacity duration-300"
                >
                  <ExternalLink className="h-3 w-3" /> View on Kalshi
                </a>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <TradeModal
        market={tradeMarket}
        open={!!tradeMarket}
        onClose={() => { setTradeMarket(null); setTradeInitialSide(undefined); }}
        mode={mode}
        initialSide={tradeInitialSide}
      />
    </div>
  );
}

interface KalshiMarketCardProps {
  market: ParsedMarket;
  signal?: AgentSignal;
  position?: OpenPosition;
  onDetail: () => void;
  onTrade: (side: "yes" | "no") => void;
}

function KalshiMarketCard({ market, signal, position, onDetail, onTrade }: KalshiMarketCardProps) {
  const theme = getCategoryTheme(market.category);
  const live = isClosingSoon(market.closeTime);

  return (
    <div
      onClick={onDetail}
      className="rounded-2xl bg-card apple-shadow cursor-pointer transition-shadow duration-200 hover:apple-shadow-hover flex flex-col overflow-hidden"
    >
      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Category label row */}
        <div className="flex items-center gap-2">
          <div className={cn("h-6 w-6 rounded-md flex items-center justify-center text-[9px] font-bold shrink-0", theme.bg, theme.text)}>
            {(market.category || "MK").slice(0, 2).toUpperCase()}
          </div>
          <span className={cn("text-[11px] font-medium uppercase tracking-wide", theme.text)}>
            {market.category}
          </span>
          {/* Agent signal pill */}
          {signal && (
            <span className={cn(
              "ml-auto inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0",
              signal.direction === "buy_yes" ? "bg-profit/15 text-profit" : "bg-amber-500/15 text-amber-500"
            )}>
              <Zap className="h-2.5 w-2.5" />
              {signal.direction === "buy_yes" ? "YES" : "NO"}
            </span>
          )}
          {/* Position pill */}
          {position && !signal && (
            <span className="ml-auto inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">
              <Wallet className="h-2.5 w-2.5" />
              Open
            </span>
          )}
        </div>

        {/* Question */}
        <p className="text-sm font-medium leading-snug text-foreground line-clamp-3 flex-1">
          {market.question}
        </p>

        {/* Live/close indicator */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {live && (
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
            </span>
          )}
          <Clock className={cn("h-3 w-3", live && "hidden")} />
          <span>{market.endDate}</span>
        </div>

        {/* YES / NO probability rows */}
        <div className="space-y-2">
          <ProbabilityRow
            label="Yes"
            price={market.yesPrice}
            colorClass="bg-profit"
            onClick={(e) => { e.stopPropagation(); onTrade("yes"); }}
          />
          <ProbabilityRow
            label="No"
            price={market.noPrice}
            colorClass="bg-loss"
            onClick={(e) => { e.stopPropagation(); onTrade("no"); }}
          />
        </div>

        {/* Volume footer */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t border-border/40">
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" /> {formatVolume(market.volume)}
          </span>
          {market.volume24hr > 0 && (
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> {formatVolume(market.volume24hr)} 24h
            </span>
          )}
          {market.spread > 0 && (
            <span className="ml-auto">Spread: {market.spread}¢</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ProbabilityRow({
  label,
  price,
  colorClass,
  onClick,
}: {
  label: string;
  price: number;
  colorClass: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-5 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", colorClass)}
          style={{ width: `${Math.max(2, price)}%`, opacity: 0.7 }}
        />
      </div>
      <button
        onClick={onClick}
        className={cn(
          "shrink-0 h-8 w-14 rounded-full border-2 text-xs font-semibold transition-all duration-150 active:scale-95",
          label === "Yes"
            ? "border-profit/30 text-profit hover:bg-profit hover:text-white hover:border-profit"
            : "border-loss/30 text-loss hover:bg-loss hover:text-white hover:border-loss"
        )}
      >
        {price}%
      </button>
    </div>
  );
}

function StatBox({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">{label}</span>
      </div>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
