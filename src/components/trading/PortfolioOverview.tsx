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

// Fallback if strategies table can't be reached — matches onboarding seed (S-001: $500, S-002: $1k, S-005: $1k)
const PAPER_STARTING_BALANCE = 2_500;

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

    // PnL only comes from settled trades — filled trades have pnl=0 until Kalshi resolves
    let settledQuery = supabase
      .from("trades").select("pnl, mode").eq("status", "settled");
    // Open positions: placed but not yet resolved
    let openQuery = supabase
      .from("trades").select("amount, mode").eq("status", "filled").is("settled_at", null);
    // Starting balance from strategies table
    const strategiesQuery = supabase
      .from("strategies").select("starting_balance").eq("active", true);

    if (mode) {
      settledQuery = settledQuery.eq("mode", mode);
      openQuery = openQuery.eq("mode", mode);
    }

    const [{ data: settledTrades }, { data: openPositions }, { data: strategyRows }] = await Promise.all([
      settledQuery,
      openQuery,
      strategiesQuery,
    ]);

    const startingBalance = strategyRows
      ? strategyRows.reduce((s, r) => s + (r.starting_balance ?? 0), 0)
      : effectiveStartingBalance;

    const totalPnl = (settledTrades ?? []).reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winners = (settledTrades ?? []).filter(t => (t.pnl || 0) > 0).length;
    const losers = (settledTrades ?? []).filter(t => (t.pnl || 0) < 0).length;
    const capitalInFlight = (openPositions ?? []).reduce((s, t) => s + (t.amount || 0), 0);

    let portfolioValue: number;
    let cashAvailable: number;

    if (mode === "paper" || !mode) {
      // Paper: starting capital + settled P&L. Cash available = that minus what's currently in flight.
      portfolioValue = startingBalance + totalPnl;
      cashAvailable = Math.max(0, portfolioValue - capitalInFlight);
    } else {
      // Live: fetch real balance from Kalshi; fall back to trade math if API unavailable
      const kalshiBalance = await fetchKalshiBalance();
      if (kalshiBalance !== null) {
        cashAvailable = kalshiBalance;
        portfolioValue = kalshiBalance + totalPnl;
      } else {
        portfolioValue = startingBalance + totalPnl;
        cashAvailable = Math.max(0, portfolioValue - capitalInFlight);
      }
    }

    setStats({
      portfolioValue,
      cashAvailable,
      totalPnl,
      winRate: winners + losers > 0 ? Math.round((winners / (winners + losers)) * 100) : 0,
      openPositionCount: (openPositions ?? []).length,
      totalTrades: (settledTrades ?? []).length,
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
