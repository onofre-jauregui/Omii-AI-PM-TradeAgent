import { Bot, Clock, Zap, MessageSquare, BarChart3 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { fetchKalshiMarkets } from "@/lib/kalshiApi";

interface HeroStats {
  startingBalance: number;
  portfolioValue: number;
  totalReturn: number;
  totalReturnPct: number;
  todayPnl: number;
  todayPnlPct: number;
  winRate: number;
  openPositions: number;
  tradesToday: number;
  winStreak: number;
  marketsClosingToday: number;
  loading: boolean;
}

function AgentStatusBadge() {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-profit bg-profit/10 px-2.5 py-1 rounded-full shrink-0">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-profit opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-profit" />
      </span>
      Your Agent · Active
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
}) {
  const [stats, setStats] = useState<HeroStats>({
    startingBalance: 0,
    portfolioValue: 0,
    totalReturn: 0,
    totalReturnPct: 0,
    todayPnl: 0,
    todayPnlPct: 0,
    winRate: 0,
    openPositions: 0,
    tradesToday: 0,
    winStreak: 0,
    marketsClosingToday: 0,
    loading: true,
  });

  const load = useCallback(async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const [settledRes, openRes, placedTodayRes, strategiesRes, marketsRes] = await Promise.allSettled([
      // PnL comes from SETTLED trades only — filled trades have pnl=0 until resolution
      supabase
        .from("trades")
        .select("pnl, settled_at, mode")
        .eq("status", "settled")
        .order("settled_at", { ascending: false }),
      // Open positions: filled but not yet settled
      supabase
        .from("trades")
        .select("id")
        .eq("status", "filled")
        .is("settled_at", null),
      // Trades placed today (for activity count)
      supabase
        .from("trades")
        .select("id")
        .gte("created_at", todayISO),
      // Starting balance = sum of strategy starting_balances (real paper capital allocated)
      supabase
        .from("strategies")
        .select("starting_balance")
        .eq("active", true),
      fetchKalshiMarkets(200),
    ]);

    const settledTrades = settledRes.status === "fulfilled" ? (settledRes.value.data ?? []) : [];
    const openTrades = openRes.status === "fulfilled" ? (openRes.value.data ?? []) : [];
    const tradesToday = placedTodayRes.status === "fulfilled" ? (placedTodayRes.value.data?.length ?? 0) : 0;
    const strategies = strategiesRes.status === "fulfilled" ? (strategiesRes.value.data ?? []) : [];
    const markets = marketsRes.status === "fulfilled" ? marketsRes.value : [];

    // Starting balance from DB — what was allocated when strategies were set up
    const startingBalance = strategies.reduce((s: number, st: any) => s + (st.starting_balance ?? 0), 0);

    // Filter by mode if specified
    const modeTrades = mode ? settledTrades.filter(t => t.mode === mode) : settledTrades;

    // Total P&L from all settled trades
    const totalPnl = modeTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const portfolioValue = startingBalance + totalPnl;
    const totalReturnPct = startingBalance > 0
      ? parseFloat(((totalPnl / startingBalance) * 100).toFixed(2))
      : 0;

    // Today's P&L — trades that settled today
    const settledToday = modeTrades.filter(t => t.settled_at && t.settled_at >= todayISO);
    const todayPnl = settledToday.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const todayPnlPct = startingBalance > 0
      ? parseFloat(((todayPnl / startingBalance) * 100).toFixed(2))
      : 0;

    // Win rate across all settled trades
    const winners = modeTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const losers = modeTrades.filter(t => (t.pnl ?? 0) < 0).length;
    const winRate = winners + losers > 0 ? Math.round((winners / (winners + losers)) * 100) : 0;

    // Win streak from most recent settled trades
    let winStreak = 0;
    for (const t of modeTrades) {
      if ((t.pnl ?? 0) > 0) winStreak++;
      else break;
    }

    // Markets closing within 24h
    const cutoff = Date.now() + 24 * 60 * 60 * 1000;
    const marketsClosingToday = markets.filter(m => {
      if (!m.closeTime) return false;
      const t = new Date(m.closeTime).getTime();
      return t > Date.now() && t < cutoff;
    }).length;

    setStats({
      startingBalance,
      portfolioValue,
      totalReturn: totalPnl,
      totalReturnPct,
      todayPnl,
      todayPnlPct,
      winRate,
      openPositions: openTrades.length,
      tradesToday,
      winStreak,
      marketsClosingToday,
      loading: false,
    });
  }, [mode]);

  useEffect(() => { load(); }, [load]);

  const { startingBalance, portfolioValue, totalReturn, totalReturnPct, todayPnl, todayPnlPct, winRate, openPositions, tradesToday, winStreak, marketsClosingToday } = stats;
  const isUp = totalReturn >= 0;
  const isTodayUp = todayPnl >= 0;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="space-y-3 apple-reveal">
      {/* Hero card */}
      <div className="rounded-2xl bg-gradient-to-br from-card to-card/80 p-5 apple-shadow">
        {/* Greeting */}
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-3">
          {greeting} · {dateLabel}
        </p>

        {/* Label row */}
        <div className="flex items-start justify-between mb-1 gap-2">
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-widest">
            {mode === "paper" ? "Your Paper Portfolio" : mode === "live" ? "Your Portfolio" : "Your Portfolio"}
          </p>
          <AgentStatusBadge />
        </div>

        {/* Current portfolio value */}
        <h1
          className="text-[42px] font-light leading-none text-foreground mb-1"
          style={{ letterSpacing: "-0.03em" }}
        >
          {stats.loading
            ? "--"
            : `$${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
        </h1>

        {/* Starting balance context */}
        {!stats.loading && startingBalance > 0 && (
          <p className="text-[11px] text-muted-foreground mb-2">
            Started at ${startingBalance.toLocaleString("en-US")}
          </p>
        )}

        {/* All-time return + today + streak */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className={cn("text-base font-medium tabular-nums", isUp ? "text-profit" : "text-loss")}>
            {isUp ? "+" : ""}${Math.abs(totalReturn).toFixed(2)} all-time
          </span>
          <span className={cn("text-sm tabular-nums", isUp ? "text-profit" : "text-loss")}>
            ({isUp ? "+" : ""}{totalReturnPct}%)
          </span>
          {todayPnl !== 0 && (
            <span className={cn("text-xs tabular-nums text-muted-foreground")}>
              · {isTodayUp ? "+" : ""}${Math.abs(todayPnl).toFixed(2)} today
            </span>
          )}
          {winStreak >= 3 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-warning/15 text-warning px-2.5 py-0.5 rounded-full animate-pulse-gentle">
              🔥 {winStreak} streak
            </span>
          )}
        </div>

        {/* 4-up quick stats */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          <QuickStat
            label="Win Rate"
            value={winRate > 0 ? `${winRate}%` : "--"}
            color={winRate > 0 ? (winRate >= 50 ? "profit" : "loss") : undefined}
            progress={winRate > 0 ? winRate : undefined}
          />
          <QuickStat label="Placed" value={tradesToday > 0 ? `${tradesToday}` : "0"} />
          <QuickStat
            label="Open"
            value={openPositions > 0 ? `${openPositions}` : "0"}
            color={openPositions > 0 ? "primary" : undefined}
          />
          <QuickStat
            label="Mode"
            value={mode === "live" ? "Live" : "Paper"}
            color={mode === "live" ? "loss" : "primary"}
          />
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => onNavigate?.("markets")}
            className="flex items-center justify-center gap-1.5 h-10 rounded-xl bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-all active:scale-95"
          >
            <Zap className="h-3.5 w-3.5 text-primary" />
            Scan Markets
          </button>
          <button
            onClick={() => onNavigate?.("agent")}
            className="flex items-center justify-center gap-1.5 h-10 rounded-xl bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-all active:scale-95"
          >
            <MessageSquare className="h-3.5 w-3.5 text-primary" />
            Ask Agent
          </button>
          <button
            onClick={() => onNavigate?.("agent")}
            className="flex items-center justify-center gap-1.5 h-10 rounded-xl bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-all active:scale-95"
          >
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            Positions
          </button>
        </div>
      </div>

      {/* FOMO alert chips — horizontal scroll strip */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {marketsClosingToday > 0 && (
          <AlertChip
            icon={<Clock className="h-3 w-3" />}
            label={`${marketsClosingToday} market${marketsClosingToday === 1 ? "" : "s"} close today`}
            color="warning"
            onClick={() => onNavigate?.("markets")}
          />
        )}
        <AlertChip
          icon={<Bot className="h-3 w-3 animate-pulse" />}
          label="Agent scanning markets"
          color="primary"
        />
      </div>
    </div>
  );
}
