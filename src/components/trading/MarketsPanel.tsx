import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Users, Clock, TrendingUp, BarChart3, Droplets, ExternalLink, RefreshCw, Loader2, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useCallback, useMemo } from "react";
import { fetchKalshiMarkets, formatVolume, type ParsedMarket } from "@/lib/kalshiApi";
import { MOCK_MARKETS } from "@/lib/mockData";
import { cn } from "@/lib/utils";

type SortKey = "volume" | "volume24h" | "yesPrice" | "noPrice" | "endDate";
type Horizon = "any" | "today" | "week" | "month";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "volume", label: "Total Volume" },
  { value: "volume24h", label: "24h Volume" },
  { value: "yesPrice", label: "Yes Price" },
  { value: "noPrice", label: "No Price" },
  { value: "endDate", label: "Closing Soon" },
];

const HORIZON_OPTIONS: { value: Horizon; label: string; hours: number | null }[] = [
  { value: "any", label: "Any close date", hours: null },
  { value: "today", label: "Closing today", hours: 24 },
  { value: "week", label: "Closing this week", hours: 24 * 7 },
  { value: "month", label: "Closing this month", hours: 24 * 30 },
];

export function MarketsPanel() {
  const [search, setSearch] = useState("");
  const [markets, setMarkets] = useState<ParsedMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<ParsedMarket | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [sortBy, setSortBy] = useState<SortKey>("volume");
  const [horizon, setHorizon] = useState<Horizon>("any");

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKalshiMarkets(100);
      setMarkets(data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch live markets, using mock data:", err);
      setError("Using cached data — live feed unavailable");
      setMarkets(MOCK_MARKETS.map(m => ({
        ...m, ticker: m.id, description: "", volume24hr: 0, liquidity: 0,
        openInterest: 0, slug: "", active: true, spread: 0, yesBid: 0,
        yesAsk: 0, noBid: 0, noAsk: 0,
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    const interval = setInterval(loadMarkets, 10_000);
    return () => clearInterval(interval);
  }, [loadMarkets]);

  // Derive unique categories from results
  const categories = useMemo(() => {
    const cats = Array.from(new Set(markets.map(m => m.category).filter(Boolean)));
    return ["All", ...cats.sort()];
  }, [markets]);

  // Filter + sort
  const filtered = useMemo(() => {
    let list = markets;

    if (activeCategory !== "All") {
      list = list.filter(m => m.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m => m.question.toLowerCase().includes(q) || m.ticker.toLowerCase().includes(q));
    }

    // Time horizon filter using raw closeTime ISO string
    const horizonDef = HORIZON_OPTIONS.find(h => h.value === horizon);
    if (horizonDef?.hours !== null && horizonDef?.hours !== undefined) {
      const cutoff = Date.now() + horizonDef.hours * 60 * 60 * 1000;
      list = list.filter(m => {
        if (!m.closeTime) return false;
        const closeMs = new Date(m.closeTime).getTime();
        return closeMs > Date.now() && closeMs <= cutoff;
      });
    }

    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "volume": return b.volume - a.volume;
        case "volume24h": return b.volume24hr - a.volume24hr;
        case "yesPrice": return b.yesPrice - a.yesPrice;
        case "noPrice": return b.noPrice - a.noPrice;
        case "endDate": {
          const at = a.closeTime ? new Date(a.closeTime).getTime() : Infinity;
          const bt = b.closeTime ? new Date(b.closeTime).getTime() : Infinity;
          return at - bt;
        }
        default: return 0;
      }
    });

    return list;
  }, [markets, activeCategory, search, sortBy, horizon]);

  return (
    <div className="space-y-5 apple-reveal">
      {/* Data source info banner */}
      <div className="flex items-start gap-2.5 rounded-2xl bg-secondary/60 px-5 py-3.5">
        <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">Data source:</span> Kalshi public API — up to 100 open markets, 10-second auto-refresh.
          {" "}<span className="font-medium text-foreground">24h Volume</span> = contracts traded in the last 24 hours (higher = more active, better fills).
          {" "}Use <span className="font-medium text-foreground">Close date</span> to filter to markets resolving today, this week, or this month — shorter horizons are better for short-term trading.
        </p>
      </div>

      {/* Search + filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search markets or tickers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-11 rounded-xl bg-card border-0 apple-shadow h-11 text-sm"
          />
        </div>
        <Select value={horizon} onValueChange={(v) => setHorizon(v as Horizon)}>
          <SelectTrigger className="h-11 w-48 rounded-xl border-0 bg-card apple-shadow text-sm">
            <Clock className="h-3.5 w-3.5 text-muted-foreground mr-1" />
            <SelectValue placeholder="Close date" />
          </SelectTrigger>
          <SelectContent>
            {HORIZON_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
          <SelectTrigger className="h-11 w-40 rounded-xl border-0 bg-card apple-shadow text-sm">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          onClick={loadMarkets}
          disabled={loading}
          className="rounded-xl h-11 gap-2 text-sm shrink-0"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {/* Category pills */}
      {categories.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-all duration-200",
                activeCategory === cat
                  ? "bg-foreground text-background"
                  : "bg-card apple-shadow text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Status bar */}
      {error ? (
        <p className="text-sm text-warning">{error}</p>
      ) : lastUpdated && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-profit opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-profit" />
          </span>
          <span className="text-profit font-medium">Live</span>
          <span>
            · {lastUpdated.toLocaleTimeString()} · {filtered.length} of {markets.length} markets
            {activeCategory !== "All" && ` · ${activeCategory}`}
            {horizon !== "any" && ` · ${HORIZON_OPTIONS.find(h => h.value === horizon)?.label}`}
          </span>
        </div>
      )}

      {/* Market list */}
      {loading && markets.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-3 text-sm text-muted-foreground">Loading Kalshi markets...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <span className="text-sm text-muted-foreground">
            {horizon !== "any"
              ? `No markets closing ${HORIZON_OPTIONS.find(h => h.value === horizon)?.label.toLowerCase().replace("closing ", "")}${activeCategory !== "All" ? ` in ${activeCategory}` : ""}.`
              : `No markets match "${search}"${activeCategory !== "All" ? ` in ${activeCategory}` : ""}.`}
          </span>
          {horizon !== "any" && (
            <button
              onClick={() => setHorizon("any")}
              className="text-xs text-primary hover:opacity-70 transition-opacity"
            >
              Show all close dates →
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((market) => (
            <div
              key={market.id}
              className="rounded-2xl bg-card p-5 apple-shadow cursor-pointer transition-shadow duration-300 hover:apple-shadow-hover"
              onClick={() => setSelectedMarket(market)}
            >
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1 space-y-2">
                  <h3 className="text-sm font-medium leading-snug text-foreground">{market.question}</h3>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {formatVolume(market.volume)}
                    </span>
                    {market.volume24hr > 0 && (
                      <span className="flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> {formatVolume(market.volume24hr)} 24h
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {market.endDate}
                    </span>
                    {market.spread > 0 && (
                      <span className="text-[10px]">Spread: {market.spread}c</span>
                    )}
                    <Badge variant="secondary" className="text-[10px] rounded-full font-normal">
                      {market.category}
                    </Badge>
                  </div>
                </div>
                <div className="text-right space-y-2 shrink-0">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-5">Yes</span>
                      <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-profit rounded-full transition-all duration-500" style={{ width: `${market.yesPrice}%` }} />
                      </div>
                      <span className="text-xs font-medium text-profit w-8 text-right">{market.yesPrice}c</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-5">No</span>
                      <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-loss rounded-full transition-all duration-500" style={{ width: `${market.noPrice}%` }} />
                      </div>
                      <span className="text-xs font-medium text-loss w-8 text-right">{market.noPrice}c</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
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
                    <span className="text-lg font-medium text-profit">{selectedMarket.yesPrice}c</span>
                  </div>
                  <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-profit rounded-full transition-all duration-500" style={{ width: `${selectedMarket.yesPrice}%` }} />
                  </div>
                  {selectedMarket.yesBid > 0 && (
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>Bid: {selectedMarket.yesBid}c</span>
                      <span>Ask: {selectedMarket.yesAsk}c</span>
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">No</span>
                    <span className="text-lg font-medium text-loss">{selectedMarket.noPrice}c</span>
                  </div>
                  <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-loss rounded-full transition-all duration-500" style={{ width: `${selectedMarket.noPrice}%` }} />
                  </div>
                  {selectedMarket.noBid > 0 && (
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>Bid: {selectedMarket.noBid}c</span>
                      <span>Ask: {selectedMarket.noAsk}c</span>
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
                <Button className="flex-1 h-10 rounded-full text-sm bg-profit/10 text-profit hover:bg-profit/20 border-0">
                  Buy Yes @ {selectedMarket.yesAsk || selectedMarket.yesPrice}c
                </Button>
                <Button className="flex-1 h-10 rounded-full text-sm bg-loss/10 text-loss hover:bg-loss/20 border-0">
                  Buy No @ {selectedMarket.noAsk || selectedMarket.noPrice}c
                </Button>
              </div>

              {selectedMarket.ticker && (
                <a
                  href={`https://kalshi.com/markets/${selectedMarket.ticker}`}
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
