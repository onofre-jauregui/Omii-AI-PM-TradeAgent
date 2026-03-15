import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpRight, ArrowDownRight, Clock } from "lucide-react";
import { MOCK_TRADES } from "@/lib/mockData";

export function TradeLog() {
  return (
    <div className="apple-reveal">
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Trade History</h3>
          </div>
        </div>
        <ScrollArea className="h-[500px]">
          <div className="divide-y divide-border">
            {MOCK_TRADES.map((trade) => (
              <div key={trade.id} className="flex items-center gap-4 px-6 py-4 transition-colors duration-300 hover:bg-secondary/50">
                <div className={`p-2 rounded-xl ${trade.side === 'buy' ? 'bg-profit/10' : 'bg-loss/10'}`}>
                  {trade.side === 'buy' ? (
                    <ArrowUpRight className="h-4 w-4 text-profit" />
                  ) : (
                    <ArrowDownRight className="h-4 w-4 text-loss" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{trade.market}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {trade.timestamp} · {trade.strategy}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">
                    {trade.side.toUpperCase()} {trade.outcome} @ {trade.price}¢
                  </p>
                  <p className={`text-sm font-medium tabular-nums ${trade.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                  </p>
                </div>
                <Badge variant="secondary" className={`text-[10px] rounded-full font-normal ${
                  trade.status === 'filled' ? 'bg-profit/10 text-profit' :
                  trade.status === 'pending' ? 'bg-warning/10 text-warning' : ''
                }`}>
                  {trade.status}
                </Badge>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
