import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpRight, ArrowDownRight, Clock, Loader2, RefreshCw, ThumbsUp, ThumbsDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
  user_rating: "good" | "bad" | null;
  user_id: string | null;
}

export function TradeLog({ filterMode }: { filterMode?: "paper" | "live" }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [ratingId, setRatingId] = useState<string | null>(null);

  const loadTrades = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("trades")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (filterMode) q = q.eq("mode", filterMode);
    const { data, error } = await q;

    if (!error && data) {
      setTrades(data as Trade[]);
    }
    setLoading(false);
  }, [filterMode]);

  useEffect(() => {
    loadTrades();

    // Subscribe to real-time updates + fire toast on profitable close
    const channel = supabase
      .channel(`trades-realtime-${filterMode ?? "all"}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, (payload) => {
        if ((payload.new as Trade)?.pnl != null && (payload.new as Trade).pnl! > 0) {
          const q = (payload.new as Trade).market_question ?? "";
          toast.success(`+$${((payload.new as Trade).pnl!).toFixed(2)} · ${q.substring(0, 40)}${q.length > 40 ? "…" : ""}`, {
            duration: 4000,
            icon: "🎯",
          });
        }
        loadTrades();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trades" }, () => {
        loadTrades();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadTrades, filterMode]);

  async function rateTrade(trade: Trade, rating: "good" | "bad") {
    if (ratingId) return;
    setRatingId(trade.id);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      await supabase.from("trades").update({ user_rating: rating }).eq("id", trade.id);

      const isGood = rating === "good";
      const pnlStr = trade.pnl != null ? `P&L: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}` : "P&L: pending";
      await supabase.from("agent_memory").insert({
        memory_type: isGood ? "success" : "mistake",
        title: `User rated ${trade.strategy ?? "manual"} trade ${isGood ? "good" : "bad"}: ${trade.side.toUpperCase()} ${trade.ticker ?? trade.market_id}`,
        content: `User marked this trade as ${isGood ? "a good decision" : "a bad decision"}. Market: "${trade.market_question}". Side: ${trade.side.toUpperCase()} @ ${trade.filled_price ?? trade.price}¢. Amount: $${trade.amount}. ${pnlStr}. Strategy: ${trade.strategy ?? "manual"}. ${isGood ? "Reinforce this type of setup." : "Avoid or be more selective with this type of setup."}`,
        source_type: "user_feedback",
        related_trade_ids: [trade.id],
        strategy_id: trade.strategy ?? null,
        confidence: 0.7,
        tags: ["user_feedback", trade.strategy ?? "manual", trade.side, isGood ? "good_trade" : "bad_trade"],
        user_id: user?.id ?? null,
      });

      setTrades((prev) => prev.map((t) => t.id === trade.id ? { ...t, user_rating: rating } : t));
      toast.success(`Feedback saved — agent will ${isGood ? "look for more setups like this" : "be more selective here"}`);
    } catch {
      toast.error("Failed to save feedback");
    } finally {
      setRatingId(null);
    }
  }

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
            <h3 className="text-sm font-medium text-muted-foreground">
              {filterMode === "paper" ? "Paper Trade History" : filterMode === "live" ? "Live Trade History" : "Trade History"}
            </h3>
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
                <div key={trade.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-6 sm:py-4 transition-colors duration-300 hover:bg-secondary/50">
                  <div className={`p-1.5 sm:p-2 rounded-xl shrink-0 mt-0.5 ${trade.action === 'buy' ? 'bg-profit/10' : 'bg-loss/10'}`}>
                    {trade.action === 'buy' ? (
                      <ArrowUpRight className="h-4 w-4 text-profit" />
                    ) : (
                      <ArrowDownRight className="h-4 w-4 text-loss" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Top row: question + PnL (mobile inline, desktop separate column) */}
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-foreground line-clamp-2 sm:truncate leading-snug">
                        {trade.market_question}
                      </p>
                      {trade.pnl !== null && trade.pnl !== 0 && (
                        <p className={`text-sm font-semibold tabular-nums shrink-0 sm:hidden ${(trade.pnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                          {(trade.pnl ?? 0) >= 0 ? '+' : ''}${(trade.pnl ?? 0).toFixed(2)}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(trade.created_at).toLocaleString()} · {trade.strategy || "Manual"}
                      {trade.order_id && <span className="font-mono ml-1">#{trade.order_id.slice(0, 8)}</span>}
                    </p>
                    {/* Mobile badges + rating inline */}
                    <div className="flex items-center gap-1.5 mt-1 sm:hidden">
                      <Badge variant="secondary" className={`text-[10px] rounded-full font-normal ${statusColor(trade.status)}`}>
                        {trade.status}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px] rounded-full font-normal">
                        {trade.mode}
                      </Badge>
                      <button
                        onClick={(e) => { e.stopPropagation(); rateTrade(trade, "good"); }}
                        disabled={!!ratingId}
                        className={`p-1 rounded-lg transition-colors ${trade.user_rating === "good" ? "text-emerald-500 bg-emerald-500/10" : "text-muted-foreground hover:text-emerald-500"}`}
                      >
                        {ratingId === trade.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); rateTrade(trade, "bad"); }}
                        disabled={!!ratingId}
                        className={`p-1 rounded-lg transition-colors ${trade.user_rating === "bad" ? "text-red-500 bg-red-500/10" : "text-muted-foreground hover:text-red-500"}`}
                      >
                        <ThumbsDown className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  {/* Desktop: right column with PnL + badges + rating */}
                  <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                    <p className="text-xs text-muted-foreground">
                      {trade.action.toUpperCase()} {trade.side.toUpperCase()} @ {trade.filled_price || trade.price}c
                    </p>
                    <p className="text-xs text-muted-foreground">${trade.amount} · {trade.order_type || "limit"}</p>
                    {trade.pnl !== null && trade.pnl !== 0 && (
                      <p className={`text-sm font-medium tabular-nums ${(trade.pnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {(trade.pnl ?? 0) >= 0 ? '+' : ''}${(trade.pnl ?? 0).toFixed(2)}
                      </p>
                    )}
                    <Badge variant="secondary" className={`text-[10px] rounded-full font-normal ${statusColor(trade.status)}`}>
                      {trade.status}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] rounded-full font-normal">
                      {trade.mode}
                    </Badge>
                    {/* Trade rating */}
                    <div className="flex gap-1 mt-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); rateTrade(trade, "good"); }}
                        disabled={!!ratingId}
                        className={`p-1 rounded-lg transition-colors ${trade.user_rating === "good" ? "text-emerald-500 bg-emerald-500/10" : "text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10"}`}
                        title="Good trade"
                      >
                        {ratingId === trade.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); rateTrade(trade, "bad"); }}
                        disabled={!!ratingId}
                        className={`p-1 rounded-lg transition-colors ${trade.user_rating === "bad" ? "text-red-500 bg-red-500/10" : "text-muted-foreground hover:text-red-500 hover:bg-red-500/10"}`}
                        title="Bad trade"
                      >
                        <ThumbsDown className="h-3 w-3" />
                      </button>
                    </div>
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
