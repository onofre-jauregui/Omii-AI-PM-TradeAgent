import { Card, CardContent } from "@/components/ui/card";
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
        ...m,
        description: "",
        volume24hr: 0,
        liquidity: 0,
        category: m.category,
        slug: "",
        active: true,
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    const interval = setInterval(loadMarkets, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, [loadMarkets]);

  const filtered = markets.filter(m =>
    m.question.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4 animate-slide-up">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search markets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-card border-border font-mono text-sm"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={loadMarkets}
          disabled={loading}
          className="font-mono text-xs gap-1.5 h-10"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          REFRESH
        </Button>
      </div>

      {error && (
        <div className="text-xs font-mono text-warning bg-warning/10 border border-warning/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {lastUpdated && !error && (
        <p className="text-[10px] font-mono text-muted-foreground">
          LIVE DATA • Updated {lastUpdated.toLocaleTimeString()} • {markets.length} markets • Auto-refresh 60s
        </p>
      )}

      {loading && markets.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-2 font-mono text-sm text-muted-foreground">Loading live markets...</span>
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((market) => (
            <Card
              key={market.id}
              className="bg-card border-border hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => setSelectedMarket(market)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <h3 className="text-sm font-medium leading-tight">{market.question}</h3>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono flex-wrap">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" /> {formatVolume(market.volume)} vol
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {market.endDate}
                      </span>
                      <Badge variant="outline" className="text-[10px] h-5">
                        {market.category}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-right space-y-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground w-6">YES</span>
                        <div className="w-20 h-2 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full bg-profit rounded-full" style={{ width: `${market.yesPrice}%` }} />
                        </div>
                        <span className="text-xs font-mono font-semibold text-profit">{market.yesPrice}¢</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground w-6">NO</span>
                        <div className="w-20 h-2 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full bg-loss rounded-full" style={{ width: `${market.noPrice}%` }} />
                        </div>
                        <span className="text-xs font-mono font-semibold text-loss">{market.noPrice}¢</span>
                      </div>
                    </div>
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" className="h-7 text-[10px] font-mono bg-profit/20 text-profit hover:bg-profit/30 border-0">
                        BUY YES
                      </Button>
                      <Button size="sm" className="h-7 text-[10px] font-mono bg-loss/20 text-loss hover:bg-loss/30 border-0">
                        BUY NO
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Market Detail Dialog */}
      <Dialog open={!!selectedMarket} onOpenChange={(open) => !open && setSelectedMarket(null)}>
        <DialogContent className="bg-card border-border max-w-lg">
          {selectedMarket && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base font-medium leading-tight pr-6">
                  {selectedMarket.question}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                {/* Price bars */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">YES</span>
                    <span className="text-lg font-mono font-bold text-profit">{selectedMarket.yesPrice}¢</span>
                  </div>
                  <div className="w-full h-3 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-profit rounded-full transition-all" style={{ width: `${selectedMarket.yesPrice}%` }} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">NO</span>
                    <span className="text-lg font-mono font-bold text-loss">{selectedMarket.noPrice}¢</span>
                  </div>
                  <div className="w-full h-3 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-loss rounded-full transition-all" style={{ width: `${selectedMarket.noPrice}%` }} />
                  </div>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 gap-3">
                  <StatBox icon={BarChart3} label="TOTAL VOLUME" value={formatVolume(selectedMarket.volume)} />
                  <StatBox icon={TrendingUp} label="24H VOLUME" value={formatVolume(selectedMarket.volume24hr)} />
                  <StatBox icon={Droplets} label="LIQUIDITY" value={formatVolume(selectedMarket.liquidity)} />
                  <StatBox icon={Clock} label="END DATE" value={selectedMarket.endDate} />
                </div>

                {/* Description */}
                {selectedMarket.description && (
                  <div className="bg-secondary/50 border border-border rounded-md p-3">
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
                      {selectedMarket.description}
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  <Button className="flex-1 h-9 text-xs font-mono bg-profit/20 text-profit hover:bg-profit/30 border-0">
                    BUY YES @ {selectedMarket.yesPrice}¢
                  </Button>
                  <Button className="flex-1 h-9 text-xs font-mono bg-loss/20 text-loss hover:bg-loss/30 border-0">
                    BUY NO @ {selectedMarket.noPrice}¢
                  </Button>
                </div>

                {selectedMarket.slug && (
                  <a
                    href={`https://polymarket.com/event/${selectedMarket.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" /> View on Polymarket
                  </a>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatBox({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="bg-secondary/50 border border-border rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-mono font-bold text-foreground">{value}</p>
    </div>
  );
}
