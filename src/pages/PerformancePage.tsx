import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Area, AreaChart, BarChart, Bar, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import {
  TrendingUp, TrendingDown, Target, BarChart3,
  Activity, Clock, RefreshCw, Bot, HelpCircle,
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
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  pendingExposure: number;
  avgHoldHours: number;
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

interface CategoryRow {
  category: string;
  trades: number;
  settled: number;
  wins: number;
  pnl: number;
}

interface DistBucket {
  label: string;
  count: number;
  pnl: number;
}

interface OpenTrade {
  id: string;
  ticker: string;
  market_question: string | null;
  side: string;
  price: number;
  amount: number;
  strategy: string | null;
  filled_at: string;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchAll() {
  const [tradesRes, settledRes, openRes] = await Promise.all([
    supabase
      .from("trades")
      .select("strategy_id, strategy, side, action, price, amount, pnl, status, settled_at, resolution, created_at, ticker, market_question, mode")
      .eq("mode", "paper")
      .in("status", ["filled", "settled"])
      .order("created_at", { ascending: true }),
    supabase
      .from("trades")
      .select("ticker, market_question, side, price, amount, pnl, resolution, settled_at, strategy, created_at")
      .eq("mode", "paper")
      .eq("status", "settled")
      .order("settled_at", { ascending: false })
      .limit(25),
    supabase
      .from("trades")
      .select("id, ticker, market_question, side, price, amount, strategy, filled_at")
      .eq("mode", "paper")
      .eq("status", "filled")
      .is("settled_at", null)
      .is("exit_reason", null)
      .order("filled_at", { ascending: false }),
  ]);

  return {
    allTrades: tradesRes.data ?? [],
    recentSettled: settledRes.data ?? [],
    openTrades: openRes.data ?? [],
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

function categoryFromTicker(ticker: string | null | undefined): string {
  if (!ticker) return "Other";
  if (/KXHIGH|WEATHER|TEMP/i.test(ticker)) return "Weather";
  if (/KXBTC|KXETH|CRYPTO/i.test(ticker)) return "Crypto";
  if (/KXFED|KXCPI|KXGDP|KXPAYROLLS|KXCHCUTS/i.test(ticker)) return "Macro";
  if (/KXNHL|KXNBA|KXMLB|SPORTS/i.test(ticker)) return "Sports";
  return "Other";
}

/**
 * Parse expected settlement date from a Kalshi ticker.
 * Weather: KXHIGHAUS-26APR18-T78  → "Apr 18, 2026"
 * FED:     KXFED-27APR-T3.25      → "Apr 2026 (FOMC)"
 * Returns null if no date found.
 */
function parseSettlementDate(ticker: string): string | null {
  const MONTHS: Record<string, string> = {
    JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
    JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec",
  };
  // Weather pattern: -26APR18- (YYMONDD)
  const wx = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})-/i);
  if (wx) {
    const mon = MONTHS[wx[2].toUpperCase()];
    return mon ? `${mon} ${wx[3]}, 20${wx[1]}` : null;
  }
  // FED/event pattern: -27APR- (YYMON, no day)
  const ev = ticker.match(/-(\d{2})([A-Z]{3})-/i);
  if (ev) {
    const mon = MONTHS[ev[2].toUpperCase()];
    return mon ? `${mon} 20${ev[1]} (FOMC)` : null;
  }
  return null;
}

/** Max potential profit on a trade (win side pays $1/contract). */
function potentialProfit(price: number, amount: number): number {
  if (price <= 0) return 0;
  const priceDollars = price / 100;
  const contracts = amount / priceDollars;
  return parseFloat((contracts * (1 - priceDollars)).toFixed(2));
}

/** Max potential loss = amount at risk. */
function potentialLoss(amount: number): number {
  return amount;
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

type Era = "all" | "redesign" | "mtd";
const ERA_CUTOFFS: Record<Era, string | null> = {
  all: null,
  redesign: "2026-05-07T00:00:00Z", // S-002 hard price guard deployed
  mtd: "2026-05-01T00:00:00Z",
};
const ERA_LABELS: Record<Era, string> = {
  all: "All time",
  redesign: "Post-redesign (May 7+)",
  mtd: "MTD (May 1+)",
};

const OPEN_POSITIONS_DEFAULT_SHOW = 6;

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  "S-002": "Buys NO on highly-priced contracts (90–95¢), betting on market overconfidence",
  "S-005": "Trades NWS forecast vs Kalshi implied temperature divergence",
  "S-001": "FedWatch Oracle — CME futures vs Kalshi rate market divergence (paused)",
};

export function PerformancePage() {
  const [stats, setStats] = useState<OverallStats | null>(null);
  const [strategyRows, setStrategyRows] = useState<StrategyRow[]>([]);
  const [equityData, setEquityData] = useState<EquityPoint[]>([]);
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);
  const [openTrades, setOpenTrades] = useState<OpenTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [era, setEra] = useState<Era>("mtd");
  const [allTradesRaw, setAllTradesRaw] = useState<any[]>([]);
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [pendingExposure, setPendingExposure] = useState(0);
  const [dailyPnl, setDailyPnl] = useState<{ date: string; pnl: number }[]>([]);
  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>([]);
  const [pnlDistribution, setPnlDistribution] = useState<DistBucket[]>([]);

  const applyEra = useCallback((trades: any[], selectedEra: Era) => {
    const cutoff = ERA_CUTOFFS[selectedEra];
    return cutoff ? trades.filter(t => t.created_at >= cutoff) : trades;
  }, []);

  const load = useCallback(async () => {
    const { allTrades: rawAll, recentSettled, openTrades: openPositions } = await fetchAll();
    setAllTradesRaw(rawAll);
    const allTrades = applyEra(rawAll, era);

    // ── Overall stats ──
    const settled = allTrades.filter(t => t.settled_at);
    const openUnsettled = allTrades.filter(t => !t.settled_at);
    const wins = settled.filter(t => (t.pnl ?? 0) > 0);
    const losses = settled.filter(t => (t.pnl ?? 0) < 0);
    const realizedPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalDeployed = allTrades.reduce((s, t) => s + (t.amount ?? 0), 0);
    const firstAt = allTrades[0]?.created_at ?? null;
    const daysRunning = firstAt
      ? Math.max(1, Math.ceil((Date.now() - new Date(firstAt).getTime()) / 86_400_000))
      : 0;

    // ── Extended stats ──
    const grossWins = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

    const settledSortedForDd = [...settled].sort(
      (a, b) => new Date(a.settled_at!).getTime() - new Date(b.settled_at!).getTime()
    );
    let runningDd = 0, ddPeak = 0, maxDd = 0;
    for (const t of settledSortedForDd) {
      runningDd += t.pnl ?? 0;
      ddPeak = Math.max(ddPeak, runningDd);
      maxDd = Math.max(maxDd, ddPeak - runningDd);
    }

    const pendingExposureVal = openPositions.reduce((s: number, t: any) => s + (t.amount ?? 0), 0);

    const holdTimes = settled
      .filter(t => t.settled_at && t.created_at)
      .map(t => (new Date(t.settled_at!).getTime() - new Date(t.created_at).getTime()) / 3600000);
    const avgHoldHours = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    setPendingExposure(pendingExposureVal);

    setStats({
      totalTrades: allTrades.length,
      settledTrades: settled.length,
      openTrades: openUnsettled.length,
      realizedPnl,
      wins: wins.length,
      losses: losses.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      totalDeployed,
      daysRunning,
      firstTradeAt: firstAt,
      avgWin,
      avgLoss,
      profitFactor,
      maxDrawdown: maxDd,
      pendingExposure: pendingExposureVal,
      avgHoldHours,
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

    // ── Daily P&L ──
    const dailyMap = new Map<string, number>();
    for (const t of settled) {
      if (!t.settled_at) continue;
      const day = t.settled_at.slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + (t.pnl ?? 0));
    }
    const dailyPnlData = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => ({
        date: new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        pnl: parseFloat(pnl.toFixed(2)),
      }));
    setDailyPnl(dailyPnlData);

    // ── Category breakdown ──
    const catMap = new Map<string, CategoryRow>();
    for (const t of allTrades) {
      const cat = categoryFromTicker(t.ticker);
      if (!catMap.has(cat)) {
        catMap.set(cat, { category: cat, trades: 0, settled: 0, wins: 0, pnl: 0 });
      }
      const row = catMap.get(cat)!;
      row.trades++;
      if (t.settled_at) {
        row.settled++;
        row.pnl += t.pnl ?? 0;
        if ((t.pnl ?? 0) > 0) row.wins++;
      }
    }
    setCategoryRows([...catMap.values()].sort((a, b) => b.pnl - a.pnl));

    // ── P&L distribution histogram ──
    const BUCKET_MIN = -10, BUCKET_MAX = 10;
    const buckets = new Map<number, number>();
    for (let i = BUCKET_MIN; i <= BUCKET_MAX; i++) buckets.set(i, 0);
    for (const t of settled) {
      if (t.pnl == null) continue;
      const bucket = Math.max(BUCKET_MIN, Math.min(BUCKET_MAX, Math.floor(t.pnl)));
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    setPnlDistribution(
      [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([pnl, count]) => ({
          label: pnl === BUCKET_MIN ? `≤${pnl}` : pnl === BUCKET_MAX ? `≥+${pnl}` : pnl >= 0 ? `+${pnl}` : `${pnl}`,
          count,
          pnl,
        }))
    );

    setRecentTrades(recentSettled as RecentTrade[]);
    setOpenTrades(openPositions as OpenTrade[]);
    setLastUpdated(new Date());
    setLoading(false);
  }, [era, applyEra]);

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

      <main className="max-w-[900px] mx-auto px-8 py-8 space-y-8 apple-reveal">
        {/* Title + era selector */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-light tracking-tight text-foreground" style={{ letterSpacing: "-0.03em" }}>
              Track Record
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Autonomous paper trading on Kalshi prediction markets.
              {stats?.firstTradeAt && ` Running since ${formatDate(stats.firstTradeAt)}.`}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-secondary p-1 shrink-0">
            {(Object.keys(ERA_LABELS) as Era[]).map((e) => (
              <button
                key={e}
                onClick={() => setEra(e)}
                title={e === "redesign" ? "Hard price guard deployed May 7 — excludes contracts entered above 80¢" : undefined}
                className={cn(
                  "px-3 py-1 text-xs rounded-lg font-medium transition-colors flex items-center gap-1",
                  era === e
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {ERA_LABELS[e]}
                {e === "redesign" && <HelpCircle className="h-3 w-3 opacity-50" />}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* ── 1. Equity curve — hero chart ─────────────────────────────── */}
            <div className="rounded-2xl bg-card p-6 apple-shadow">
              <div className="flex items-end justify-between mb-6">
                <div>
                  <p className="text-xs text-muted-foreground mb-1 uppercase tracking-widest">Cumulative P&L</p>
                  <p
                    className={cn("text-5xl font-light tabular-nums", isPositive ? "text-profit" : "text-loss")}
                    style={{ letterSpacing: "-0.04em" }}
                  >
                    {formatPnl(currentPnl)}
                  </p>
                  {pendingExposure > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      +${pendingExposure.toFixed(0)} pending in {openTrades.length} open position{openTrades.length !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  <span>{equityData.length - 1} settlements</span>
                </div>
              </div>

              {equityData.length > 1 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={equityData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `$${v}`} width={48} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px", fontSize: "12px", color: "hsl(var(--foreground))" }}
                      formatter={(v: number) => [formatPnl(v), "P&L"]}
                    />
                    <Area type="monotone" dataKey="pnl"
                      stroke={isPositive ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                      strokeWidth={2} fill="url(#pnlGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[240px] flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">No settled trades yet — curve appears once markets resolve.</p>
                </div>
              )}
            </div>

            {/* ── 2. Stat cards ─────────────────────────────────────────────── */}
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

            {/* ── 3. Second stat row ────────────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                icon={TrendingUp}
                label="Avg Win"
                value={stats!.avgWin > 0 ? `+$${stats!.avgWin.toFixed(2)}` : "--"}
                valueClass="text-profit"
                sub="per settled win"
              />
              <StatCard
                icon={TrendingDown}
                label="Avg Loss"
                value={stats!.avgLoss > 0 ? `-$${stats!.avgLoss.toFixed(2)}` : "--"}
                valueClass="text-loss"
                sub="per settled loss"
              />
              <StatCard
                icon={BarChart3}
                label="Profit Factor"
                value={stats!.profitFactor === Infinity ? "∞" : stats!.profitFactor > 0 ? `${stats!.profitFactor.toFixed(2)}x` : "--"}
                valueClass={stats!.profitFactor >= 1 ? "text-profit" : "text-loss"}
                sub="gross wins ÷ losses"
              />
              <StatCard
                icon={Activity}
                label="Max Drawdown"
                value={stats!.maxDrawdown > 0 ? `-$${stats!.maxDrawdown.toFixed(2)}` : "$0"}
                valueClass={stats!.maxDrawdown > 0 ? "text-loss" : ""}
                sub="peak-to-trough"
              />
            </div>

            {/* ── 4. Daily P&L bar chart ────────────────────────────────────── */}
            {dailyPnl.length > 1 && (
              <div className="rounded-2xl bg-card p-6 apple-shadow">
                <p className="text-xs text-muted-foreground mb-4 uppercase tracking-widest">Daily P&L</p>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={dailyPnl} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px", fontSize: "12px" }}
                      formatter={(v: number) => [formatPnl(v), "P&L"]}
                    />
                    <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                      {dailyPnl.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl >= 0 ? "hsl(var(--profit))" : "hsl(var(--loss))"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* ── 5. P&L distribution histogram ────────────────────────────── */}
            {pnlDistribution.some(b => b.count > 0) && (
              <div className="rounded-2xl bg-card p-6 apple-shadow">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">P&L Distribution</p>
                  <p className="text-xs text-muted-foreground">outcome skew per settled trade</p>
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={pnlDistribution} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <XAxis dataKey="label" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px", fontSize: "12px" }}
                      formatter={(v: number) => [v, "trades"]}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {pnlDistribution.map((b, i) => (
                        <Cell key={i} fill={b.pnl >= 0 ? "hsl(var(--profit))" : "hsl(var(--loss))"} fillOpacity={b.count === 0 ? 0.15 : 0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* ── 6. Benchmark callout ──────────────────────────────────────── */}
            {stats!.settledTrades > 0 && stats!.realizedPnl !== 0 && (
              <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
                <span className={cn("font-medium", stats!.realizedPnl >= 0 ? "text-profit" : "text-loss")}>
                  Agent MTD: {((stats!.realizedPnl / Math.max(stats!.totalDeployed * 0.5, 1)) * (365 / Math.max(stats!.daysRunning, 1)) * 100).toFixed(0)}% ann.
                </span>
                <span>·</span>
                <span>S&P 500: ~12%/yr</span>
                <span>·</span>
                <span>HY Savings: ~5%/yr</span>
              </div>
            )}

            {/* ── 6. Open Positions (collapsed to 6, expandable) ────────────── */}
            {openTrades.length > 0 && (
              <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-medium text-muted-foreground">Open Positions</h3>
                    <Badge variant="secondary" className="text-[10px] rounded-full">{openTrades.length}</Badge>
                  </div>
                  <Badge variant="secondary" className="text-[10px] rounded-full flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    Pending settlement
                  </Badge>
                </div>
                <div className="divide-y divide-border">
                  {(showAllPositions ? openTrades : openTrades.slice(0, OPEN_POSITIONS_DEFAULT_SHOW)).map((t) => {
                    const settleDate = parseSettlementDate(t.ticker);
                    const maxWin = potentialProfit(t.price, t.amount);
                    return (
                      <div key={t.id} className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/40 transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {t.market_question ?? t.ticker}
                          </p>
                          <div className="flex items-center gap-3 mt-1">
                            <span className={cn(
                              "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                              t.side === "yes" ? "bg-profit/10 text-profit" : "bg-loss/10 text-loss"
                            )}>
                              {t.side.toUpperCase()}
                            </span>
                            <span className="text-xs text-muted-foreground">@ {t.price}¢</span>
                            {t.strategy && <span className="text-xs text-muted-foreground">· {t.strategy}</span>}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-6 text-right shrink-0">
                          <div>
                            <p className="text-[10px] text-muted-foreground">At Risk</p>
                            <p className="text-sm font-medium tabular-nums">${t.amount.toFixed(0)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground">Max Win</p>
                            <p className="text-sm font-medium tabular-nums text-profit">+${maxWin.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground">Settles</p>
                            <p className="text-xs tabular-nums text-muted-foreground">{settleDate ?? "TBD"}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="px-6 py-3 border-t border-border bg-secondary/20 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Total at risk: <span className="font-medium text-foreground">${openTrades.reduce((s, t) => s + t.amount, 0).toFixed(0)}</span>
                  </span>
                  {openTrades.length > OPEN_POSITIONS_DEFAULT_SHOW && (
                    <button
                      onClick={() => setShowAllPositions(!showAllPositions)}
                      className="text-xs text-primary hover:underline"
                    >
                      {showAllPositions
                        ? "Show less"
                        : `Show all ${openTrades.length} positions`}
                    </button>
                  )}
                </div>
              </div>
            )}

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
                          {(STRATEGY_DESCRIPTIONS[row.strategy_id ?? ""] || null) && (
                            <p className="text-xs text-muted-foreground mt-0.5 italic">
                              {STRATEGY_DESCRIPTIONS[row.strategy_id ?? ""]}
                            </p>
                          )}
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

            {/* ── By Category ───────────────────────────────────────────── */}
            {categoryRows.length > 0 && (
              <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium text-muted-foreground">By Market Category</h3>
                </div>
                <div className="divide-y divide-border">
                  {categoryRows.map((row) => {
                    const winRate = row.settled > 0 ? Math.round((row.wins / row.settled) * 100) : null;
                    const maxPnl = Math.max(...categoryRows.map(r => Math.abs(r.pnl)), 1);
                    const barWidth = Math.abs(row.pnl) / maxPnl * 100;
                    return (
                      <div key={row.category} className="px-6 py-3.5 hover:bg-secondary/40 transition-colors">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-sm font-medium">{row.category}</span>
                          <div className="flex items-center gap-6 text-right">
                            <div>
                              <p className="text-[10px] text-muted-foreground">Trades</p>
                              <p className="text-sm tabular-nums">{row.trades}</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Win%</p>
                              <p className={cn("text-sm tabular-nums", winRate !== null ? (winRate >= 50 ? "text-profit" : "text-loss") : "")}>
                                {winRate !== null ? `${winRate}%` : "--"}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">P&L</p>
                              <p className={cn("text-sm font-medium tabular-nums", row.pnl >= 0 ? "text-profit" : "text-loss")}>
                                {formatPnl(row.pnl)}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="h-1 rounded-full bg-secondary overflow-hidden">
                          <div
                            className={cn("h-full rounded-full transition-all", row.pnl >= 0 ? "bg-profit/60" : "bg-loss/60")}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
