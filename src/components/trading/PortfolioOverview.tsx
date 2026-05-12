import { TrendingUp, TrendingDown, DollarSign, BarChart3, Target, Clock, Loader2, Wallet } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string)?.trim();
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim();

async function fetchKalshiBalance(): Promise<number | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/functions/v1/kalshi-proxy?endpoint=portfolio/balance`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    // Kalshi returns balance in cents
    if (typeof data?.balance === "number") return data.balance / 100;
    return null;
  } catch {
    return null;
  }
}

// Starting paper capital — paper trades are simulated against this balance
const PAPER_STARTING_BALANCE = 10_000;

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

interface Stats {
  portfolioValue: number;
  cashAvailable: number;
  totalPnl: number;
  winRate: number;
  openPositionCount: number;
  totalTrades: number;
}

// ─── Stat cards ───────────────────────────────────────────────────────────────
// mode: 'paper' | 'live' | undefined (all)
export function PortfolioStats({
  mode,
  startingBalance: startingBalanceProp,
}: {
  mode?: "paper" | "live";
  startingBalance?: number;
}) {
  const effectiveStartingBalance = startingBalanceProp ?? PAPER_STARTING_BALANCE;
  const [stats, setStats] = useState<Stats>({
    portfolioValue: 0, cashAvailable: 0, totalPnl: 0,
    winRate: 0, openPositionCount: 0, totalTrades: 0,
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    let filledBuysQuery = supabase
      .from("trades").select("amount, pnl, mode").eq("status", "filled").eq("action", "buy");
    let allTradesQuery = supabase
      .from("trades").select("pnl, status, action, mode").eq("status", "filled");
    let sellsQuery = supabase
      .from("trades").select("amount, mode").eq("status", "filled").eq("action", "sell");

    if (mode) {
      filledBuysQuery = filledBuysQuery.eq("mode", mode);
      allTradesQuery = allTradesQuery.eq("mode", mode);
      sellsQuery = sellsQuery.eq("mode", mode);
    }

    const [{ data: buys }, { data: allTrades }, { data: sells }] = await Promise.all([
      filledBuysQuery,
      allTradesQuery,
      sellsQuery,
    ]);

    const totalBuyAmount = (buys ?? []).reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalSellAmount = (sells ?? []).reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalPnl = (allTrades ?? []).reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winners = (allTrades ?? []).filter(t => (t.pnl || 0) > 0).length;
    const totalWithPnl = (allTrades ?? []).filter(t => t.pnl !== null && t.pnl !== 0).length;

    let portfolioValue: number;
    let cashAvailable: number;

    if (mode === "paper") {
      // Paper balance = starting capital - capital tied up in open positions + realized P&L
      const netInvested = Math.max(0, totalBuyAmount - totalSellAmount);
      portfolioValue = effectiveStartingBalance - netInvested + totalPnl;
      cashAvailable = portfolioValue;
    } else {
      // Live: fetch real balance from Kalshi; fall back to trade math if API unavailable
      const kalshiBalance = await fetchKalshiBalance();
      if (kalshiBalance !== null) {
        cashAvailable = kalshiBalance;
        portfolioValue = kalshiBalance + totalPnl;
      } else {
        portfolioValue = totalBuyAmount - totalSellAmount + totalPnl;
        cashAvailable = portfolioValue;
      }
    }

    setStats({
      portfolioValue,
      cashAvailable,
      totalPnl,
      winRate: totalWithPnl > 0 ? Math.round((winners / totalWithPnl) * 100) : 0,
      openPositionCount: (buys ?? []).length,
      totalTrades: (allTrades ?? []).length,
    });
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`portfolio-stats-rt-${mode ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, mode]);

  const pnlPercent = mode === "paper"
    ? ((stats.totalPnl / effectiveStartingBalance) * 100).toFixed(1)
    : stats.portfolioValue > 0
      ? ((stats.totalPnl / stats.portfolioValue) * 100).toFixed(1)
      : "0.0";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (mode === "paper") {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={Wallet}
          label="Paper Balance"
          value={`$${stats.portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
          sub={`Started at $${effectiveStartingBalance.toLocaleString()}`}
        />
        <StatCard
          icon={stats.totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="Total P&L"
          value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
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

  // Live / all-mode stat cards
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        icon={Wallet}
        label="Cash Balance"
        value={`$${stats.cashAvailable.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
        sub="Kalshi account"
      />
      <StatCard
        icon={stats.totalPnl >= 0 ? TrendingUp : TrendingDown}
        label="Total P&L"
        value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
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

// ─── Active positions list ────────────────────────────────────────────────────
export function PortfolioOverview({ mode }: { mode?: "paper" | "live" }) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("trades")
      .select("*")
      .eq("status", "filled")
      .eq("action", "buy")
      .order("created_at", { ascending: false })
      .limit(20);
    if (mode) q = q.eq("mode", mode);
    const { data } = await q;
    setPositions((data ?? []) as Position[]);
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`portfolio-positions-rt-${mode ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, mode]);

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
          <h3 className="text-sm font-medium text-muted-foreground">
            {mode === "paper" ? "Open Paper Positions" : "Active Positions"}
          </h3>
        </div>
        {positions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {mode === "paper"
              ? "No open paper positions. Use the Demo agent to start paper trading."
              : "No open positions. Use the Live Agent to start trading."}
          </p>
        ) : (
          <div className="space-y-1">
            {positions.map((pos, i) => (
              <div
                key={`${pos.market_id}-${i}`}
                className="flex items-start justify-between py-4 border-b border-border last:border-0"
              >
                <div className="flex-1 pr-3 min-w-0">
                  <p className="text-sm font-medium text-foreground line-clamp-2">{pos.market_question}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {pos.side.toUpperCase()} @ {pos.filled_price || pos.price}c · ${pos.amount}
                    {pos.strategy && <span> · {pos.strategy}</span>}
                  </p>
                </div>
                <div className="text-right shrink-0">
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
    <div className="rounded-2xl bg-card p-4 sm:p-5 apple-shadow transition-shadow duration-300 hover:apple-shadow-hover">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-medium tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className={`text-sm text-muted-foreground mt-0.5`}>{sub}</p>}
    </div>
  );
}
