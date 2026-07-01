import { Bot, Clock, ArrowUpRight } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { fetchKalshiMarkets } from "@/lib/kalshiApi";

// Kalshi markets cache — shared across renders, refreshed every 15 min
let kalshiMarketsCache: { data: any[]; ts: number } | null = null;
let kalshiMarketsFetch: Promise<any[]> | null = null;
async function getCachedKalshiMarkets(): Promise<any[]> {
  const now = Date.now();
  if (kalshiMarketsCache && now - kalshiMarketsCache.ts < 15 * 60 * 1000) {
    return kalshiMarketsCache.data;
  }
  if (!kalshiMarketsFetch) {
    kalshiMarketsFetch = fetchKalshiMarkets(200).then(data => {
      kalshiMarketsCache = { data, ts: Date.now() };
      kalshiMarketsFetch = null;
      return data;
    }).catch(() => { kalshiMarketsFetch = null; return []; });
  }
  return kalshiMarketsFetch;
}

interface ChartPoint { date: string; value: number; }

interface HeroStats {
  startingBalance: number;
  portfolioValue: number;
  kalshiBalance: number | null;
  totalReturn: number;
  totalReturnPct: number;
  todayPnl: number;
  winRate: number;
  openPositions: number;
  tradesToday: number;
  winStreak: number;
  marketsClosingToday: number;
  lastTradeAt: string | null;
  settledCount: number;
  chartPoints: ChartPoint[];
  loading: boolean;
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function AgentStatusBadge() {
  const [lastRun, setLastRun] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const fetch = () =>
      supabase
        .from("compliance_log")
        .select("created_at")
        .in("event_type", ["auto_trade_run", "auto_trade_skipped"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => setLastRun(data?.created_at ?? null));

    fetch();
    const interval = setInterval(fetch, 2 * 60 * 1000); // refresh every 2 min
    return () => clearInterval(interval);
  }, []);

  if (lastRun === undefined) return null;

  const minsAgo = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 60000 : Infinity;
  const isStale = minsAgo > 240;
  const colorClass = isStale ? "text-yellow-500 bg-yellow-500/10" : "text-profit bg-profit/10";
  const dotClass = isStale ? "bg-yellow-500" : "bg-profit";
  const label = isStale ? "Agent · Stale" : "Your Agent · Active";

  return (
    <div className={`flex items-center gap-1.5 text-[11px] font-medium ${colorClass} px-2.5 py-1 rounded-full shrink-0`}>
      <span className="relative flex h-1.5 w-1.5">
        {!isStale && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${dotClass} opacity-75`} />}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotClass}`} />
      </span>
      {label}
    </div>
  );
}

function QuickStat({
  label, value, color, progress,
}: {
  label: string; value: string; color?: "profit" | "loss" | "primary" | "warning"; progress?: number;
}) {
  return (
    <div className="rounded-xl bg-secondary/70 px-2 py-2 text-center flex flex-col gap-1">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wide leading-none">{label}</p>
      <p className={cn(
        "text-xs font-semibold tabular-nums leading-none",
        color === "profit" && "text-profit",
        color === "loss" && "text-loss",
        color === "primary" && "text-primary",
        color === "warning" && "text-warning",
        !color && "text-foreground",
      )}>
        {value}
      </p>
      {progress !== undefined && (
        <div className="w-full h-0.5 bg-border rounded-full overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-700", progress >= 50 ? "bg-profit" : "bg-loss")}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function AlertChip({
  icon, label, color = "primary", onClick,
}: {
  icon: React.ReactNode; label: string; color?: "primary" | "warning"; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium shrink-0",
        "transition-all duration-150 active:scale-95 border",
        color === "warning" && "bg-warning/10 text-warning border-warning/20",
        color === "primary" && "bg-primary/10 text-primary border-primary/20",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function DashboardHero({
  mode,
  onNavigate,
  userId: userIdProp,
}: {
  mode?: "paper" | "live";
  onNavigate?: (tab: string) => void;
  userId?: string;
}) {
  const loadIdRef = useRef(0); // cancels stale concurrent loads
  const [stats, setStats] = useState<HeroStats>({
    startingBalance: 0,
    portfolioValue: 0,
    kalshiBalance: null,
    totalReturn: 0,
    totalReturnPct: 0,
    todayPnl: 0,
    winRate: 0,
    openPositions: 0,
    tradesToday: 0,
    winStreak: 0,
    marketsClosingToday: 0,
    lastTradeAt: null,
    settledCount: 0,
    chartPoints: [],
    loading: true,
  });

  const load = useCallback(async () => {
    const myId = ++loadIdRef.current; // increment; stale loads will see myId !== loadIdRef.current
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    const MAY_START = "2026-04-22T00:00:00.000Z";

    // Use prop if available — avoids a network round-trip on every load
    const userId = userIdProp ?? (await supabase.auth.getUser()).data.user?.id;

    // Fetch Kalshi wallet balance when in live mode (non-blocking — may fail if no key set)
    const kalshiBalanceFetch: Promise<number | null> = mode === "live"
      ? supabase.auth.getSession().then(({ data: { session } }) => {
          if (!session) return null;
          const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kalshi-ping`;
          return fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(j => (j?.balance_usd != null ? Number(j.balance_usd) : null))
            .catch(() => null);
        })
      : Promise.resolve(null);

    const [settledRes, openRes, placedTodayRes, strategiesRes, lastPlacedRes] = await Promise.allSettled([
      // PnL comes from SETTLED trades only — filled trades have pnl=0 until resolution
      supabase
        .from("trades")
        .select("pnl, settled_at, mode")
        .eq("status", "settled")
        .eq("user_id", userId ?? "")
        .gte("settled_at", MAY_START)
        .order("settled_at", { ascending: false })
        .limit(500),
      // Open positions: filled but not yet settled
      supabase
        .from("trades")
        .select("id, ticker")
        .eq("status", "filled")
        .eq("user_id", userId ?? "")
        .is("settled_at", null),
      // Trades placed today (for activity count)
      supabase
        .from("trades")
        .select("id")
        .eq("user_id", userId ?? "")
        .gte("created_at", todayISO),
      // Starting balance — sum of strategies matching the current mode
      (() => {
        let q = supabase.from("strategies").select("starting_balance, mode").eq("user_id", userId ?? "");
        if (mode) q = q.eq("mode", mode);
        return q;
      })(),
      // Most recently SETTLED trade — "Last settled" chip aligns with streak metric
      supabase
        .from("trades")
        .select("settled_at")
        .eq("user_id", userId ?? "")
        .eq("status", "settled")
        .order("settled_at", { ascending: false })
        .limit(1),
    ]);

    const kalshiBalance = await kalshiBalanceFetch;

    const settledTrades = settledRes.status === "fulfilled" ? (settledRes.value.data ?? []) : [];
    const openTrades = openRes.status === "fulfilled" ? (openRes.value.data ?? []) : [];
    const tradesToday = placedTodayRes.status === "fulfilled" ? (placedTodayRes.value.data?.length ?? 0) : 0;
    const strategies = strategiesRes.status === "fulfilled" ? (strategiesRes.value.data ?? []) : [];
    const lastPlaced = lastPlacedRes.status === "fulfilled" ? (lastPlacedRes.value.data?.[0]?.settled_at ?? null) : null;

    // Kalshi markets loaded from cache (non-blocking — won't delay hero render)
    const markets = kalshiMarketsCache?.data ?? [];

    // Starting balance from mode-filtered strategies
    const startingBalance = strategies.reduce((s: number, st: any) => s + (st.starting_balance ?? 0), 0);

    // Filter by mode if specified
    const modeTrades = mode ? settledTrades.filter(t => t.mode === mode) : settledTrades;

    // Total P&L from all settled trades
    const totalPnl = modeTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const portfolioValue = startingBalance + totalPnl;
    const totalReturnPct = startingBalance > 0
      ? parseFloat(((totalPnl / startingBalance) * 100).toFixed(1))
      : 0;

    // Today's P&L — trades that settled today
    const settledToday = modeTrades.filter(t => t.settled_at && t.settled_at >= todayISO);
    const todayPnl = settledToday.reduce((s, t) => s + (t.pnl ?? 0), 0);

    // Win rate across all settled trades
    const winners = modeTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const losers = modeTrades.filter(t => (t.pnl ?? 0) < 0).length;
    const winRate = winners + losers > 0 ? Math.round((winners / (winners + losers)) * 100) : 0;

    // Markets closing within 24h that the user has an open position in
    const openTickers = new Set((openTrades as any[]).map(t => t.ticker).filter(Boolean));
    const cutoff = Date.now() + 24 * 60 * 60 * 1000;
    const marketsClosingToday = markets.filter(m => {
      if (!m.closeTime || !m.ticker) return false;
      if (!openTickers.has(m.ticker)) return false;
      const t = new Date(m.closeTime).getTime();
      return t > Date.now() && t < cutoff;
    }).length;

    // Build daily P&L map — shared by streak calc and chart
    const byDay: Record<string, number> = {};
    for (const t of modeTrades) {
      const day = (t.settled_at ?? "").slice(0, 10);
      if (!day) continue;
      byDay[day] = (byDay[day] ?? 0) + (t.pnl ?? 0);
    }

    // Win streak = consecutive calendar days with positive net P&L, working
    // backwards from the most recent day that had any settled trades.
    // Starting from today would always break on days with no settlements yet.
    let winStreak = 0;
    const sortedTradeDays = Object.keys(byDay).sort().reverse();
    if (sortedTradeDays.length > 0) {
      const lastDay = new Date(sortedTradeDays[0] + "T12:00:00Z");
      const todayNoon = new Date();
      todayNoon.setUTCHours(12, 0, 0, 0);
      const daysSinceLast = Math.floor((todayNoon.getTime() - lastDay.getTime()) / 86_400_000);
      if (daysSinceLast <= 1) {
        // Last settlement was today or yesterday — streak is live
        const streakCursor = new Date(sortedTradeDays[0] + "T12:00:00Z");
        while (true) {
          const key = streakCursor.toISOString().slice(0, 10);
          if (!byDay[key]) break;          // gap day — no trades at all
          if (byDay[key] <= 0) break;      // losing day
          winStreak++;
          streakCursor.setUTCDate(streakCursor.getUTCDate() - 1);
        }
      }
      // daysSinceLast > 1: no positive traction in last 24h — streak stays 0
    }
    // Fill every calendar date Apr 22 → today so the chart is continuous
    let cum = startingBalance;
    const chartPoints: ChartPoint[] = [];
    const cursor = new Date("2026-04-22T12:00:00Z");
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    while (cursor <= today) {
      const key = cursor.toISOString().slice(0, 10);
      cum += byDay[key] ?? 0;
      chartPoints.push({
        date: cursor.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        value: Math.round(cum * 100) / 100,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    if (myId !== loadIdRef.current) return; // a newer load fired — discard this result
    setStats({
      startingBalance,
      portfolioValue,
      kalshiBalance,
      totalReturn: totalPnl,
      totalReturnPct,
      todayPnl,
      winRate,
      openPositions: openTrades.length,
      tradesToday,
      winStreak,
      marketsClosingToday,
      lastTradeAt: lastPlaced,
      settledCount: modeTrades.length,
      chartPoints,
      loading: false,
    });
  }, [mode, userIdProp]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("dashboard-hero-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  // Lazy-load Kalshi markets after initial render — primes cache, then re-runs load()
  // so marketsClosingToday is computed without blocking the hero's first paint.
  useEffect(() => {
    getCachedKalshiMarkets().then(markets => {
      if (markets.length > 0) load();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { startingBalance, portfolioValue, kalshiBalance, totalReturn, totalReturnPct, todayPnl, winRate, openPositions, tradesToday, winStreak, marketsClosingToday, lastTradeAt, settledCount } = stats;
  const isUp = totalReturn >= 0;
  const isTodayUp = todayPnl >= 0;
  // In live mode, prefer real Kalshi wallet balance over synthetic portfolio value
  const displayValue = mode === "live" && kalshiBalance != null ? kalshiBalance : portfolioValue;
  const isLiveWallet = mode === "live" && kalshiBalance != null;

  return (
    <div className="space-y-3 apple-reveal">
      {/* Hero card */}
      <div className="rounded-2xl bg-gradient-to-br from-card to-card/80 p-5 apple-shadow">

        {/* Top row: label + status */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {isLiveWallet ? "Kalshi Wallet" : mode === "paper" ? "Portfolio" : "Live Portfolio"}
          </p>
          <div className="flex flex-col items-end gap-1">
            <AgentStatusBadge />
            {winStreak >= 2 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-warning/15 text-warning px-2 py-0.5 rounded-full">
                🔥 {winStreak} day streak
              </span>
            )}
          </div>
        </div>

        {/* Portfolio value — the number */}
        <h1
          className="text-[44px] font-light leading-none text-foreground"
          style={{ letterSpacing: "-0.04em" }}
        >
          {stats.loading
            ? <span className="text-muted-foreground">--</span>
            : `$${displayValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
        </h1>

        {/* P&L delta row */}
        <div className="flex items-center gap-2 flex-wrap mt-1.5 mb-4">
          <span className={cn(
            "inline-flex items-center gap-1 text-sm font-medium tabular-nums px-2 py-0.5 rounded-full",
            isUp ? "text-profit bg-profit/10" : "text-loss bg-loss/10"
          )}>
            <ArrowUpRight className={cn("h-3.5 w-3.5", !isUp && "rotate-180")} />
            {isUp ? "+" : ""}{totalReturnPct}%
            <span className="text-[11px] opacity-70">({isUp ? "+" : ""}${Math.abs(totalReturn).toFixed(2)})</span>
          </span>
          {todayPnl !== 0 && (
            <span className={cn("text-xs tabular-nums", isTodayUp ? "text-profit" : "text-loss")}>
              {isTodayUp ? "+" : ""}${Math.abs(todayPnl).toFixed(2)} today
            </span>
          )}
        </div>

        {/* Equity sparkline */}
        {stats.chartPoints.length > 2 && (
          <div className="my-3 -mx-1">
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={stats.chartPoints} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="heroGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis domain={["auto", "auto"]} hide />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  fill="url(#heroGradient)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          <QuickStat
            label="Win Rate"
            value={winRate > 0 ? `${winRate}%` : "--"}
            color={winRate > 0 ? (winRate >= 50 ? "profit" : "loss") : undefined}
            progress={winRate > 0 ? winRate : undefined}
          />
          <QuickStat
            label="Settled"
            value={settledCount > 0 ? `${settledCount}` : "0"}
          />
          <QuickStat
            label="Open"
            value={openPositions > 0 ? `${openPositions}` : "0"}
            color={openPositions > 0 ? "primary" : undefined}
          />
          <QuickStat
            label="Today"
            value={tradesToday > 0 ? `${tradesToday}` : "0"}
            color={tradesToday > 0 ? "profit" : undefined}
          />
        </div>

      </div>

      {/* Status chips */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {lastTradeAt && (
          <AlertChip
            icon={<Bot className="h-3 w-3" />}
            label={`Last settled: ${timeAgo(lastTradeAt)}`}
            color="primary"
          />
        )}
        {marketsClosingToday > 0 && (
          <AlertChip
            icon={<Clock className="h-3 w-3" />}
            label={`${marketsClosingToday} of your position${marketsClosingToday === 1 ? "" : "s"} settle today`}
            color="warning"
            onClick={() => onNavigate?.("markets")}
          />
        )}
        {!lastTradeAt && !stats.loading && (
          <AlertChip
            icon={<Bot className="h-3 w-3 animate-pulse" />}
            label="Agent scanning — first trades appear within 30 min"
            color="primary"
          />
        )}
      </div>
    </div>
  );
}
