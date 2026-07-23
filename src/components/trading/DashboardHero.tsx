import { Bot, Clock, ArrowUpRight } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { fetchKalshiMarkets } from "@/lib/kalshiApi";
import { usePortfolioSummary, useEquityCurve, useKalshiWallet, type EquityDay } from "@/lib/queries/portfolio";
import { useOpenPositions } from "@/lib/queries/trades";

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

// Build the cumulative equity curve (Apr 22 → today) and the win streak from
// the daily settled-P&L buckets returned by get_equity_curve. Mirrors the old
// client logic exactly, but over ~60 daily rows instead of thousands of trades.
function buildEquity(equity: EquityDay[], startingBalance: number): { chartPoints: ChartPoint[]; winStreak: number } {
  const byDay: Record<string, number> = {};
  for (const e of equity) byDay[e.day] = (byDay[e.day] ?? 0) + e.dayPnl;

  // Win streak: consecutive calendar days with positive net P&L, working back
  // from the most recent day that had settled trades — only if that was today or
  // yesterday, else there's no live traction.
  let winStreak = 0;
  const sortedTradeDays = Object.keys(byDay).sort().reverse();
  if (sortedTradeDays.length > 0) {
    const lastDay = new Date(sortedTradeDays[0] + "T12:00:00Z");
    const todayNoon = new Date();
    todayNoon.setUTCHours(12, 0, 0, 0);
    const daysSinceLast = Math.floor((todayNoon.getTime() - lastDay.getTime()) / 86_400_000);
    if (daysSinceLast <= 1) {
      const cursor = new Date(sortedTradeDays[0] + "T12:00:00Z");
      while (true) {
        const key = cursor.toISOString().slice(0, 10);
        if (!byDay[key]) break;          // gap day — no trades
        if (byDay[key] <= 0) break;      // losing day
        winStreak++;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      }
    }
  }

  // Continuous daily cumulative equity from the starting balance.
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
  return { chartPoints, winStreak };
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
}: {
  mode?: "paper" | "live";
  onNavigate?: (tab: string) => void;
  userId?: string;
}) {
  // Server-aggregated portfolio metrics (one summary row + ~60 daily buckets),
  // cached per mode. Switching paper<->live shows the target mode's cached data
  // instantly after the first visit — no full client-side re-aggregation, and no
  // cross-mode flicker (each mode is its own cache key, no keepPreviousData).
  const { data: summary, isLoading: loading } = usePortfolioSummary(mode);
  const { data: equity } = useEquityCurve(mode);
  const { data: openPos } = useOpenPositions(mode);
  const { data: walletBalance } = useKalshiWallet(mode);

  // Kalshi markets for the "settling today" chip (module-cached, 15-min TTL).
  const [markets, setMarkets] = useState<any[]>(() => kalshiMarketsCache?.data ?? []);
  useEffect(() => {
    let cancelled = false;
    getCachedKalshiMarkets().then(m => { if (!cancelled) setMarkets(m); });
    return () => { cancelled = true; };
  }, []);

  const startingBalance = summary?.startingBalance ?? 0;
  const totalReturn = summary?.totalPnl ?? 0;
  const portfolioValue = startingBalance + totalReturn;
  const totalReturnPct = startingBalance > 0
    ? parseFloat(((totalReturn / startingBalance) * 100).toFixed(1))
    : 0;
  const todayPnl = summary?.todayPnl ?? 0;
  const winRate = summary && (summary.winners + summary.losers) > 0
    ? Math.round((summary.winners / (summary.winners + summary.losers)) * 100)
    : 0;
  const openPositions = summary?.openPositions ?? 0;
  const tradesToday = summary?.tradesToday ?? 0;
  const settledCount = summary?.settledCount ?? 0;
  const lastTradeAt = summary?.lastSettledAt ?? null;
  const kalshiBalance = mode === "live" ? (walletBalance ?? null) : null;

  // Equity curve + win streak from the daily buckets.
  const { chartPoints, winStreak } = useMemo(
    () => buildEquity(equity ?? [], startingBalance),
    [equity, startingBalance],
  );

  // Markets closing within 24h that the user holds an open position in.
  const marketsClosingToday = useMemo(() => {
    const openTickers = new Set(
      ((openPos ?? []) as Array<{ ticker?: string | null }>).map(t => t.ticker).filter(Boolean),
    );
    const now = Date.now();
    const cutoff = now + 24 * 60 * 60 * 1000;
    return (markets ?? []).filter((m: any) => {
      if (!m.closeTime || !m.ticker || !openTickers.has(m.ticker)) return false;
      const t = new Date(m.closeTime).getTime();
      return t > now && t < cutoff;
    }).length;
  }, [openPos, markets]);

  const isUp = totalReturn >= 0;
  const isTodayUp = todayPnl >= 0;
  const displayValue = mode === "live" && kalshiBalance != null ? kalshiBalance : portfolioValue;
  const isLiveWallet = mode === "live" && kalshiBalance != null;

  // CTA: one action that changes by state
  const cta = (() => {
    if (mode === "paper") return { label: "Go Live", tab: "settings", color: "primary" as const };
    if (marketsClosingToday > 0) return { label: `${marketsClosingToday} position${marketsClosingToday === 1 ? "" : "s"} settling today`, tab: "markets", color: "warning" as const };
    if (lastTradeAt) return { label: `View latest trade`, tab: "agent", color: "primary" as const };
    return null;
  })();

  return (
    <div className="space-y-3 apple-reveal">
      {/* Hero card */}
      <div className="rounded-2xl bg-gradient-to-br from-card to-card/80 p-5 apple-shadow">

        {/* Top row: wallet label + live agent pulse */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {isLiveWallet ? "Kalshi Wallet" : mode === "paper" ? "Paper Portfolio" : "Live Portfolio"}
          </p>
          <AgentStatusBadge />
        </div>

        {/* Dominant headline: return % — the biggest thing on screen */}
        <div className="flex items-end gap-3 mb-1">
          <span
            className={cn(
              "font-semibold leading-none tabular-nums",
              loading ? "text-muted-foreground" : (isUp ? "text-profit" : "text-loss"),
            )}
            style={{ fontSize: "clamp(3rem, 10vw, 4.5rem)", letterSpacing: "-0.04em" }}
          >
            {loading
              ? "--"
              : `${isUp ? "+" : ""}${totalReturnPct}%`
            }
          </span>
          {!loading && (
            <ArrowUpRight
              className={cn(
                "h-6 w-6 mb-2 shrink-0",
                isUp ? "text-profit" : "text-loss rotate-180",
              )}
            />
          )}
        </div>

        {/* Portfolio dollar value — secondary, below the % */}
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-2xl font-light text-foreground tabular-nums" style={{ letterSpacing: "-0.02em" }}>
            {loading
              ? <span className="text-muted-foreground text-lg">loading…</span>
              : `$${displayValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            }
          </span>
          <span className={cn("text-xs tabular-nums", isUp ? "text-profit" : "text-loss")}>
            {!loading && `(${isUp ? "+" : ""}$${Math.abs(totalReturn).toFixed(2)} all-time)`}
          </span>
        </div>

        {/* Today velocity line */}
        <div className="flex items-center gap-3 mb-4 min-h-[20px]">
          {!loading && todayPnl !== 0 && (
            <span className={cn(
              "inline-flex items-center gap-1 text-xs font-medium tabular-nums px-2 py-0.5 rounded-full",
              isTodayUp ? "text-profit bg-profit/10" : "text-loss bg-loss/10",
            )}>
              {isTodayUp ? "▲" : "▼"} {isTodayUp ? "Up" : "Down"} ${Math.abs(todayPnl).toFixed(2)} today
            </span>
          )}
          {winStreak >= 2 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-warning/15 text-warning px-2 py-0.5 rounded-full">
              {winStreak} day streak
            </span>
          )}
        </div>

        {/* Equity sparkline */}
        {chartPoints.length > 2 && (
          <div className="my-3 -mx-1">
            <ResponsiveContainer width="100%" height={100}>
              <AreaChart data={chartPoints} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="heroGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={isUp ? "hsl(var(--profit))" : "hsl(var(--loss))"} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={isUp ? "hsl(var(--profit))" : "hsl(var(--loss))"} stopOpacity={0} />
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
                  stroke={isUp ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                  strokeWidth={1.5}
                  fill="url(#heroGradient)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Secondary stats — compact, not competing with the headline */}
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

        {/* Single CTA — changes by state */}
        {!loading && cta && (
          <button
            onClick={() => onNavigate?.(cta.tab)}
            className={cn(
              "w-full flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium transition-all duration-150 active:scale-[0.98] border",
              cta.color === "warning"
                ? "bg-warning/10 text-warning border-warning/20 hover:bg-warning/15"
                : "bg-primary/8 text-primary border-primary/20 hover:bg-primary/12",
            )}
          >
            <span>{cta.label}</span>
            <ArrowUpRight className="h-4 w-4 opacity-70 rotate-[0deg]" />
          </button>
        )}
      </div>

      {/* Status chips */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {lastTradeAt && (
          <AlertChip
            icon={<Bot className="h-3 w-3" />}
            label={`Last settled ${timeAgo(lastTradeAt)}`}
            color="primary"
          />
        )}
        {marketsClosingToday > 0 && (
          <AlertChip
            icon={<Clock className="h-3 w-3" />}
            label={`${marketsClosingToday} position${marketsClosingToday === 1 ? "" : "s"} settle today`}
            color="warning"
            onClick={() => onNavigate?.("markets")}
          />
        )}
        {!lastTradeAt && !loading && (
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
