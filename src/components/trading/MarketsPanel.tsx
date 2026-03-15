import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Users, Clock, TrendingUp, BarChart3, Droplets, ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useCallback } from "react";
import { fetchPolymarketEvents, formatVolume, type ParsedMarket } from "@/lib/polymarketApi";
import { MOCK_MARKETS } from "@/lib/mockData";

export function MarketsPanel() {
  const [search, setSearch] = useState("");
  const [markets, setMarkets] = useState<ParsedMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<ParsedMarket | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPolymarketEvents(30);
      setMarkets(data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch live markets, using mock data:", err);
      setError("Using cached data — live feed unavailable");
      setMarkets(MOCK_MARKETS.map(m => ({
        ...m, description: "", volume24hr: 0, liquidity: 0, slug: "", active: true,
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    const interval = setInterval(loadMarkets, 60_000);
    return () => clearInterval(interval);
  }, [loadMarkets]);

  const filtered = markets.filter(m =>
    m.question.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 apple-reveal">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search markets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-11 rounded-xl bg-card border-0 apple-shadow h-11 text-sm"
          />
        </div>
        <Button
          variant="secondary"
          onClick={loadMarkets}
          disabled={loading}
          className="rounded-xl h-11 gap-2 text-sm"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <p className="text-sm text-warning">{error}</p>
      )}

      {lastUpdated && !error && (
        <p className="text-xs text-muted-foreground">
          Live · Updated {lastUpdated.toLocaleTimeString()} · {markets.length} markets · Auto-refresh 60s
        </p>
      )}

      {loading && markets.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-3 text-sm text-muted-foreground">Loading live markets...</span>
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
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {formatVolume(market.volume)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {market.endDate}
                    </span>
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
                      <span className="text-xs font-medium text-profit w-8 text-right">{market.yesPrice}¢</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground w-5">No</span>
                      <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-loss rounded-full transition-all duration-500" style={{ width: `${market.noPrice}%` }} />
                      </div>
                      <span className="text-xs font-medium text-loss w-8 text-right">{market.noPrice}¢</span>
                    </div>
                  </div>
                  <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" className="h-7 text-[11px] rounded-full px-3 bg-profit/10 text-profit hover:bg-profit/20 border-0">
                      Buy Yes
                    </Button>
                    <Button size="sm" className="h-7 text-[11px] rounded-full px-3 bg-loss/10 text-loss hover:bg-loss/20 border-0">
                      Buy No
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!selectedMarket} onOpenChange={(open) => !open && setSelectedMarket(null)}>
        <DialogContent className="rounded-2xl border-0 apple-shadow max-w-lg p-0 overflow-hidden">
          {selectedMarket && (
            <div className="p-6 space-y-5">
              <DialogHeader>
                <DialogTitle className="text-base font-medium leading-snug pr-6">
                  {selectedMarket.question}
                </DialogTitle>
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
                </div>
                <div>
                  <div className="flex justify-between mb-1.5">
                    <span className="text-xs text-muted-foreground">No</span>
                    <span className="text-lg font-medium text-loss">{selectedMarket.noPrice}¢</span>
                  </div>
                  <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-loss rounded-full transition-all duration-500" style={{ width: `${selectedMarket.noPrice}%` }} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <StatBox icon={BarChart3} label="Total Volume" value={formatVolume(selectedMarket.volume)} />
                <StatBox icon={TrendingUp} label="24h Volume" value={formatVolume(selectedMarket.volume24hr)} />
                <StatBox icon={Droplets} label="Liquidity" value={formatVolume(selectedMarket.liquidity)} />
                <StatBox icon={Clock} label="End Date" value={selectedMarket.endDate} />
              </div>

              {selectedMarket.description && (
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
                  {selectedMarket.description}
                </p>
              )}

              <div className="flex gap-3">
                <Button className="flex-1 h-10 rounded-full text-sm bg-profit/10 text-profit hover:bg-profit/20 border-0">
                  Buy Yes @ {selectedMarket.yesPrice}¢
                </Button>
                <Button className="flex-1 h-10 rounded-full text-sm bg-loss/10 text-loss hover:bg-loss/20 border-0">
                  Buy No @ {selectedMarket.noPrice}¢
                </Button>
              </div>

              {selectedMarket.slug && (
                <a
                  href={`https://polymarket.com/event/${selectedMarket.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80 transition-opacity duration-300"
                >
                  <ExternalLink className="h-3 w-3" /> View on Polymarket
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
