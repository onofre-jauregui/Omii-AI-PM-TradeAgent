import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpRight, ArrowDownRight, Clock, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Trade {
  id: string;
  ticker: string | null;
  market_id: string;
  market_question: string;
  side: string;
  action: string;
  price: number;
  amount: number;
  strategy: string | null;
  mode: string;
  status: string;
  pnl: number | null;
  notes: string | null;
  order_id: string | null;
  order_type: string | null;
  filled_price: number | null;
  created_at: string;
}

export function TradeLog() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTrades = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (!error && data) {
      setTrades(data as Trade[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTrades();

    // Subscribe to real-time updates
    const channel = supabase
      .channel("trades-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        loadTrades();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadTrades]);

  const statusColor = (status: string) => {
    switch (status) {
      case "filled": return "bg-profit/10 text-profit";
      case "open": case "partial": return "bg-primary/10 text-primary";
      case "pending": return "bg-warning/10 text-warning";
      case "failed": return "bg-loss/10 text-loss";
      case "cancelled": return "bg-muted text-muted-foreground";
      default: return "";
    }
  };

  return (
    <div className="apple-reveal">
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Trade History</h3>
            <span className="text-[10px] text-muted-foreground">({trades.length} trades)</span>
          </div>
          <Button variant="ghost" size="sm" onClick={loadTrades} disabled={loading} className="h-7 text-xs gap-1">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
        <ScrollArea className="h-[500px]">
          {loading && trades.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-3 text-sm text-muted-foreground">Loading trades...</span>
            </div>
          ) : trades.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <span className="text-sm text-muted-foreground">No trades yet. Use the Agent to start trading.</span>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {trades.map((trade) => (
                <div key={trade.id} className="flex items-center gap-4 px-6 py-4 transition-colors duration-300 hover:bg-secondary/50">
                  <div className={`p-2 rounded-xl ${trade.action === 'buy' ? 'bg-profit/10' : 'bg-loss/10'}`}>
                    {trade.action === 'buy' ? (
                      <ArrowUpRight className="h-4 w-4 text-profit" />
                    ) : (
                      <ArrowDownRight className="h-4 w-4 text-loss" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{trade.market_question}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(trade.created_at).toLocaleString()} · {trade.strategy || "Manual"}
                      {trade.order_id && <span className="font-mono ml-1">#{trade.order_id.slice(0, 8)}</span>}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">
                      {trade.action.toUpperCase()} {trade.side.toUpperCase()} @ {trade.filled_price || trade.price}c
                    </p>
                    <p className="text-xs text-muted-foreground">${trade.amount} · {trade.order_type || "limit"}</p>
                    {trade.pnl !== null && trade.pnl !== 0 && (
                      <p className={`text-sm font-medium tabular-nums ${(trade.pnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {(trade.pnl ?? 0) >= 0 ? '+' : ''}${(trade.pnl ?? 0).toFixed(2)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="secondary" className={`text-[10px] rounded-full font-normal ${statusColor(trade.status)}`}>
                      {trade.status}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] rounded-full font-normal">
                      {trade.mode}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
