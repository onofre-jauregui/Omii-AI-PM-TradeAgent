import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, TrendingUp, Users, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { MOCK_MARKETS } from "@/lib/mockData";

export function MarketsPanel() {
  const [search, setSearch] = useState("");
  const filtered = MOCK_MARKETS.filter(m =>
    m.question.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4 animate-slide-up">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search markets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 bg-card border-border font-mono text-sm"
        />
      </div>

      <div className="grid gap-3">
        {filtered.map((market) => (
          <Card key={market.id} className="bg-card border-border hover:border-primary/50 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <h3 className="text-sm font-medium leading-tight">{market.question}</h3>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> ${(market.volume / 1000).toFixed(0)}K vol
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
                  <div className="flex gap-1">
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
    </div>
  );
}
