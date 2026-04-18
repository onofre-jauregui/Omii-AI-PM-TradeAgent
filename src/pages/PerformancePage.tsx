import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Area, AreaChart, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import {
  TrendingUp, TrendingDown, Target, BarChart3,
  Activity, Clock, RefreshCw, Bot,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OverallStats {
  totalTrades: number;
  settledTrades: number;
  openTrades: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  totalDeployed: number;
  daysRunning: number;
  firstTradeAt: string | null;
}

interface StrategyRow {
  strategy_id: string | null;
  strategy: string | null;
  trades: number;
  settled: number;
  wins: number;
  losses: number;
  pnl: number;
  deployed: number;
}

interface EquityPoint {
  date: string;
  pnl: number;
}

interface RecentTrade {
  ticker: string;
  market_question: string | null;
  side: string;
  price: number;
  amount: number;
  pnl: number | null;
  resolution: string | null;
  settled_at: string | null;
  strategy: string | null;
  created_at: string;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchAll() {
  const [tradesRes, settledRes] = await Promise.all([
    supabase
      .from("trades")
      .select("strategy_id, strategy, side, action, price, amount, pnl, status, settled_at, resolution, created_at, ticker, market_question, mode")
      .eq("mode", "paper")
      .eq("status", "filled")
      .order("created_at", { ascending: true }),
    supabase
      .from("trades")
      .select("ticker, market_question, side, price, amount, pnl, resolution, settled_at, strategy, created_at")
      .eq("mode", "paper")
      .eq("status", "filled")
      .not("settled_at", "is", null)
      .order("settled_at", { ascending: false })
      .limit(25),
  ]);

  return {
    allTrades: tradesRes.data ?? [],
    recentSettled: settledRes.data ?? [],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPnl(v: number) {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, sub, valueClass = "",
}: {
  icon: React.ElementType; label: string; value: string; sub?: string; valueClass?: string;
}) {
  return (
    <div className="rounded-2xl bg-card p-5 apple-shadow">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={cn("text-xl font-medium tabular-nums", valueClass)}>{value}</p>
      {sub && <p className="text-sm text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PerformancePage() {
  const [stats, setStats] = useState<OverallStats | null>(null);
  const [strategyRows, setStrategyRows] = useState<StrategyRow[]>([]);
  const [equityData, setEquityData] = useState<EquityPoint[]>([]);
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const { allTrades, recentSettled } = await fetchAll();

    // ── Overall stats ──
    const settled = allTrades.filter(t => t.settled_at);
    const open = allTrades.filter(t => !t.settled_at);
    const wins = settled.filter(t => (t.pnl ?? 0) > 0);
    const losses = settled.filter(t => (t.pnl ?? 0) < 0);
    const realizedPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalDeployed = allTrades.reduce((s, t) => s + (t.amount ?? 0), 0);
    const firstAt = allTrades[0]?.created_at ?? null;
    const daysRunning = firstAt
      ? Math.max(1, Math.ceil((Date.now() - new Date(firstAt).getTime()) / 86_400_000))
      : 0;

    setStats({
      totalTrades: allTrades.length,
      settledTrades: settled.length,
      openTrades: open.length,
      realizedPnl,
      wins: wins.length,
      losses: losses.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      totalDeployed,
      daysRunning,
      firstTradeAt: firstAt,
    });

    // ── Per-strategy rows ──
    const stratMap = new Map<string, StrategyRow>();
    for (const t of allTrades) {
      const key = t.strategy_id ?? t.strategy ?? "Unknown";
      if (!stratMap.has(key)) {
        stratMap.set(key, {
          strategy_id: t.strategy_id,
          strategy: t.strategy,
          trades: 0, settled: 0, wins: 0, losses: 0, pnl: 0, deployed: 0,
        });
      }
      const row = stratMap.get(key)!;
      row.trades++;
      row.deployed += t.amount ?? 0;
      if (t.settled_at) {
        row.settled++;
        const p = t.pnl ?? 0;
        row.pnl += p;
        if (p > 0) row.wins++;
        else if (p < 0) row.losses++;
      }
    }
    const rows = [...stratMap.values()].sort((a, b) => b.pnl - a.pnl);
    setStrategyRows(rows);

    // ── Equity curve (cumulative realized P&L over time) ──
    const settledSorted = allTrades
      .filter(t => t.settled_at)
      .sort((a, b) => new Date(a.settled_at!).getTime() - new Date(b.settled_at!).getTime());

    let runningPnl = 0;
    const curve: EquityPoint[] = [{ date: "Start", pnl: 0 }];
    for (const t of settledSorted) {
      runningPnl += t.pnl ?? 0;
      curve.push({
        date: new Date(t.settled_at!).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        pnl: parseFloat(runningPnl.toFixed(2)),
      });
    }
    setEquityData(curve);

    setRecentTrades(recentSettled as RecentTrade[]);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    const channel = supabase
      .channel("perf-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [load]);

  const currentPnl = equityData.length > 0 ? equityData[equityData.length - 1].pnl : 0;
  const isPositive = currentPnl >= 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header
        className="frosted-glass sticky top-0 z-40 h-12 flex items-center justify-between px-8 shrink-0"
        style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.08)" }}
      >
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-foreground" />
          <span className="text-sm font-medium tracking-tight">Trade Agent</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="text-[10px] rounded-full bg-primary/10 text-primary">
            Paper Trading
          </Badge>
          <Badge variant="secondary" className="text-[10px] rounded-full flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-profit animate-pulse" />
            Live
          </Badge>
          {lastUpdated && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <RefreshCw className="h-3 w-3" />
              {timeAgo(lastUpdated.toISOString())}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-[900px] mx-auto px-8 py-10 space-y-10 apple-reveal">
        {/* Title */}
        <div>
          <h1 className="text-3xl font-light tracking-tight text-foreground" style={{ letterSpacing: "-0.03em" }}>
            Track Record
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Autonomous paper trading on Kalshi prediction markets.
            {stats?.firstTradeAt && ` Running since ${formatDate(stats.firstTradeAt)}.`}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                icon={stats!.realizedPnl >= 0 ? TrendingUp : TrendingDown}
                label="Realized P&L"
                value={formatPnl(stats!.realizedPnl)}
                valueClass={stats!.realizedPnl >= 0 ? "text-profit" : "text-loss"}
                sub={`${stats!.settledTrades} settled`}
              />
              <StatCard
                icon={Target}
                label="Win Rate"
                value={stats!.settledTrades > 0 ? `${stats!.winRate}%` : "--"}
                valueClass={stats!.winRate >= 50 ? "text-profit" : "text-loss"}
                sub={`${stats!.wins}W / ${stats!.losses}L`}
              />
              <StatCard
                icon={BarChart3}
                label="Total Trades"
                value={`${stats!.totalTrades}`}
                sub={`${stats!.openTrades} open`}
              />
              <StatCard
                icon={Clock}
                label="Days Running"
                value={`${stats!.daysRunning}`}
                sub={stats!.firstTradeAt ? `Since ${formatDate(stats!.firstTradeAt)}` : "—"}
              />
            </div>

            {/* Equity curve */}
            <div className="rounded-2xl bg-card p-6 apple-shadow">
              <div className="flex items-end justify-between mb-6">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Cumulative P&L</p>
                  <p
                    className={cn("text-4xl font-light tabular-nums", isPositive ? "text-profit" : "text-loss")}
                    style={{ letterSpacing: "-0.03em" }}
                  >
                    {formatPnl(currentPnl)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  <span>{equityData.length - 1} settlements</span>
                </div>
              </div>

              {equityData.length > 1 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={equityData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                          stopOpacity={0.2}
                        />
                        <stop
                          offset="100%"
                          stopColor={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `$${v}`}
                      width={48}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "12px",
                        fontSize: "12px",
                        color: "hsl(var(--foreground))",
                      }}
                      formatter={(v: number) => [formatPnl(v), "P&L"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="pnl"
                      stroke={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                      strokeWidth={2}
                      fill="url(#pnlGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">No settled trades yet — curve appears once markets resolve.</p>
                </div>
              )}
            </div>

            {/* Per-strategy breakdown */}
            <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-muted-foreground">By Strategy</h3>
              </div>

              {strategyRows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">No trades yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {strategyRows.map((row) => {
                    const winRate = row.settled > 0 ? Math.round((row.wins / row.settled) * 100) : null;
                    return (
                      <div
                        key={row.strategy_id ?? row.strategy ?? "unknown"}
                        className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/40 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {row.strategy_id && (
                              <Badge variant="secondary" className="text-[10px] rounded-full font-mono px-1.5">
                                {row.strategy_id}
                              </Badge>
                            )}
                            <p className="text-sm font-medium text-foreground truncate">
                              {row.strategy ?? row.strategy_id ?? "Unknown"}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {row.trades} trades · {row.settled} settled · ${row.deployed.toFixed(0)} deployed
                          </p>
                        </div>
                        <div className="grid grid-cols-3 gap-6 text-right">
                          <div>
                            <p className="text-[10px] text-muted-foreground">P&L</p>
                            <p className={cn("text-sm font-medium tabular-nums", row.pnl >= 0 ? "text-profit" : "text-loss")}>
                              {formatPnl(row.pnl)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground">W / L</p>
                            <p className="text-sm font-medium tabular-nums">
                              {row.wins}<span className="text-muted-foreground">/</span>{row.losses}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground">Win%</p>
                            <p className={cn("text-sm font-medium tabular-nums", winRate !== null ? (winRate >= 50 ? "text-profit" : "text-loss") : "")}>
                              {winRate !== null ? `${winRate}%` : "--"}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recent settled trades */}
            <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-muted-foreground">Recent Settlements</h3>
              </div>

              {recentTrades.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  No settled trades yet. Markets typically resolve same-day for weather, or within days for event contracts.
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {recentTrades.map((t, i) => (
                    <div key={`${t.ticker}-${i}`} className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/40 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {t.market_question ?? t.ticker}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t.side.toUpperCase()} @ {t.price}¢ · ${t.amount}
                          {t.strategy && <> · {t.strategy}</>}
                          {t.settled_at && <> · {timeAgo(t.settled_at)}</>}
                        </p>
                      </div>
                      <div className="text-right">
                        {t.resolution && (
                          <Badge
                            variant="secondary"
                            className={cn(
                              "text-[9px] rounded-full mb-1",
                              t.resolution === "yes" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"
                            )}
                          >
                            {t.resolution.toUpperCase()}
                          </Badge>
                        )}
                        <p className={cn("text-sm font-medium tabular-nums", (t.pnl ?? 0) >= 0 ? "text-profit" : "text-loss")}>
                          {t.pnl !== null ? formatPnl(t.pnl) : "--"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer disclaimer */}
            <p className="text-center text-xs text-muted-foreground pb-8">
              Paper trading only — no real money at risk. All trades are simulated against real Kalshi market outcomes.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

export default PerformancePage;
