import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpRight, ArrowDownRight, Clock } from "lucide-react";
import { MOCK_TRADES } from "@/lib/mockData";

export function TradeLog() {
  return (
    <div className="animate-slide-up">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" /> TRADE HISTORY
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px]">
            <div className="space-y-2">
              {MOCK_TRADES.map((trade) => (
                <div key={trade.id} className="flex items-center gap-3 p-3 rounded-md bg-secondary/50 border border-border">
                  <div className={`p-1.5 rounded-md ${trade.side === 'buy' ? 'bg-profit/20' : 'bg-loss/20'}`}>
                    {trade.side === 'buy' ? (
                      <ArrowUpRight className="h-4 w-4 text-profit" />
                    ) : (
                      <ArrowDownRight className="h-4 w-4 text-loss" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{trade.market}</p>
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {trade.timestamp} · {trade.strategy}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-mono">
                      {trade.side.toUpperCase()} {trade.outcome} @ {trade.price}¢
                    </p>
                    <p className={`text-xs font-mono font-semibold ${trade.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                    </p>
                  </div>
                  <Badge variant="outline" className={`text-[10px] ${
                    trade.status === 'filled' ? 'border-profit/30 text-profit' :
                    trade.status === 'pending' ? 'border-warning/30 text-warning' :
                    'border-muted-foreground/30'
                  }`}>
                    {trade.status}
                  </Badge>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
