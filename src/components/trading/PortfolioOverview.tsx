import { TrendingUp, TrendingDown, DollarSign, BarChart3, Target, Clock, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Position {
  market_id: string;
  market_question: string;
  side: string;
  action: string;
  price: number;
  amount: number;
  pnl: number | null;
  strategy: string | null;
  filled_price: number | null;
}

interface PortfolioStats {
  totalValue: number;
  totalPnl: number;
  winRate: number;
  openPositionCount: number;
  totalTrades: number;
}

// ─── Stat cards only (top of dashboard) ──────────────────────────────────────
export function PortfolioStats() {
  const [stats, setStats] = useState<PortfolioStats>({
    totalValue: 0, totalPnl: 0, winRate: 0, openPositionCount: 0, totalTrades: 0,
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: buyTrades }, { data: allTrades }] = await Promise.all([
      supabase.from("trades").select("amount").eq("status", "filled").eq("action", "buy").limit(20),
      supabase.from("trades").select("pnl, status, action").eq("status", "filled"),
    ]);

    const totalPnl = (allTrades ?? []).reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winners = (allTrades ?? []).filter(t => (t.pnl || 0) > 0).length;
    const totalWithPnl = (allTrades ?? []).filter(t => t.pnl !== null && t.pnl !== 0).length;

    setStats({
      totalValue: (buyTrades ?? []).reduce((sum, t: any) => sum + (t.amount || 0), 0),
      totalPnl,
      winRate: totalWithPnl > 0 ? Math.round((winners / totalWithPnl) * 100) : 0,
      openPositionCount: (buyTrades ?? []).length,
      totalTrades: (allTrades ?? []).length,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("portfolio-stats-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const pnlPercent = stats.totalValue > 0
    ? ((stats.totalPnl / stats.totalValue) * 100).toFixed(1)
    : "0.0";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard icon={DollarSign} label="Portfolio Value" value={`$${stats.totalValue.toLocaleString()}`} />
      <StatCard
        icon={stats.totalPnl >= 0 ? TrendingUp : TrendingDown}
        label="Total P&L"
        value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toLocaleString()}`}
        valueClass={stats.totalPnl >= 0 ? "text-profit" : "text-loss"}
        sub={`${pnlPercent}%`}
      />
      <StatCard
        icon={Target}
        label="Win Rate"
        value={stats.totalTrades > 0 ? `${stats.winRate}%` : "--"}
        valueClass={stats.winRate >= 50 ? "text-profit" : "text-loss"}
      />
      <StatCard icon={BarChart3} label="Open Positions" value={`${stats.openPositionCount}`} />
    </div>
  );
}

// ─── Active positions list (bottom of dashboard) ──────────────────────────────
export function PortfolioOverview() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("trades")
      .select("*")
      .eq("status", "filled")
      .eq("action", "buy")
      .order("created_at", { ascending: false })
      .limit(20);
    setPositions((data ?? []) as Position[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("portfolio-positions-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-card apple-shadow">
      <div className="px-6 py-4">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">Active Positions</h3>
        </div>
        {positions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No open positions. Use the Agent to start trading.
          </p>
        ) : (
          <div className="space-y-1">
            {positions.map((pos, i) => (
              <div
                key={`${pos.market_id}-${i}`}
                className="flex items-center justify-between py-4 border-b border-border last:border-0"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{pos.market_question}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {pos.side.toUpperCase()} @ {pos.filled_price || pos.price}c · ${pos.amount}
                    {pos.strategy && <span> · {pos.strategy}</span>}
                  </p>
                </div>
                <div className="text-right">
                  {pos.pnl !== null && pos.pnl !== 0 && (
                    <p className={`text-sm font-medium tabular-nums ${(pos.pnl ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>
                      {(pos.pnl ?? 0) >= 0 ? "+" : ""}${(pos.pnl ?? 0).toFixed(2)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">${pos.amount.toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, valueClass = "text-foreground", sub }: {
  icon: React.ElementType; label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="rounded-2xl bg-card p-5 apple-shadow transition-shadow duration-300 hover:apple-shadow-hover">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-medium tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className={`text-sm ${valueClass} mt-0.5`}>{sub}</p>}
    </div>
  );
}
