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

const STATUS_COLOR: Record<string, string> = {
  filled:    "bg-profit/10 text-profit",
  settled:   "bg-profit/10 text-profit",
  open:      "bg-primary/10 text-primary",
  partial:   "bg-primary/10 text-primary",
  pending:   "bg-yellow-500/10 text-yellow-500",
  failed:    "bg-loss/10 text-loss",
  cancelled: "bg-secondary text-muted-foreground",
};

function fmt(date: string) {
  return new Date(date).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
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
    if (!error && data) setTrades(data as Trade[]);
    setLoading(false);
  }, [filterMode]);

  useEffect(() => {
    loadTrades();
    const channel = supabase
      .channel(`trades-realtime-${filterMode ?? "all"}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, (payload) => {
        const t = payload.new as Trade;
        if (t?.pnl != null && t.pnl > 0) {
          const q = t.market_question ?? "";
          toast.success(`+$${t.pnl.toFixed(2)} · ${q.substring(0, 40)}${q.length > 40 ? "…" : ""}`, {
            duration: 4000, icon: "🎯",
          });
        }
        loadTrades();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trades" }, () => loadTrades())
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
      setTrades(prev => prev.map(t => t.id === trade.id ? { ...t, user_rating: rating } : t));
      toast.success(`Feedback saved — agent will ${isGood ? "look for more setups like this" : "be more selective here"}`);
    } catch {
      toast.error("Failed to save feedback");
    } finally {
      setRatingId(null);
    }
  }

  return (
    <div className="apple-reveal">
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">

        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">
              {filterMode === "live" ? "Live " : ""}Trade History
            </h3>
            {!loading && (
              <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                {trades.length} trades
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={loadTrades} disabled={loading} className="h-7 w-7 p-0 rounded-full">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>

        <ScrollArea className="h-[480px]">
          {loading && trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading trades…</span>
            </div>
          ) : trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2 text-center px-6">
              <Clock className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No trades yet.</p>
              <p className="text-xs text-muted-foreground/60">Use the Agent tab to start trading.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {trades.map((trade) => {
                const pnl = trade.pnl ?? 0;
                const hasPnl = trade.pnl !== null && trade.pnl !== 0;
                const execPrice = trade.filled_price || trade.price;

                return (
                  <div key={trade.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-secondary/40 transition-colors">
                    {/* Direction icon */}
                    <div className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${trade.action === "buy" ? "bg-profit/10" : "bg-loss/10"}`}>
                      {trade.action === "buy"
                        ? <ArrowUpRight className="h-3.5 w-3.5 text-profit" />
                        : <ArrowDownRight className="h-3.5 w-3.5 text-loss" />}
                    </div>

                    {/* Main content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground leading-snug line-clamp-1">
                        {trade.market_question}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[11px] text-muted-foreground">{fmt(trade.created_at)}</span>
                        <span className="text-[11px] text-muted-foreground">·</span>
                        <span className="text-[11px] text-muted-foreground">{trade.strategy ?? "Manual"}</span>
                        <span className="text-[11px] text-muted-foreground">·</span>
                        <span className="text-[11px] text-muted-foreground uppercase">
                          {trade.action} {trade.side} @ {execPrice}¢
                        </span>
                      </div>
                    </div>

                    {/* Right: status + P&L + rating */}
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <Badge
                        variant="secondary"
                        className={`text-[10px] rounded-full font-normal ${STATUS_COLOR[trade.status] ?? ""}`}
                      >
                        {trade.status}
                      </Badge>
                      {hasPnl && (
                        <span className={`text-sm font-semibold tabular-nums ${pnl >= 0 ? "text-profit" : "text-loss"}`}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                        </span>
                      )}
                      <div className="flex gap-1">
                        <button
                          onClick={() => rateTrade(trade, "good")}
                          disabled={!!ratingId}
                          className={`p-1 rounded-md transition-colors ${trade.user_rating === "good" ? "text-emerald-500 bg-emerald-500/10" : "text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10"}`}
                          title="Good trade"
                        >
                          {ratingId === trade.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />}
                        </button>
                        <button
                          onClick={() => rateTrade(trade, "bad")}
                          disabled={!!ratingId}
                          className={`p-1 rounded-md transition-colors ${trade.user_rating === "bad" ? "text-red-500 bg-red-500/10" : "text-muted-foreground hover:text-red-500 hover:bg-red-500/10"}`}
                          title="Bad trade"
                        >
                          <ThumbsDown className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
