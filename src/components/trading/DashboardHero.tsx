import { Bot, Clock, Zap, MessageSquare, TrendingUp, ArrowUpRight } from "lucide-react";
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
  winRate: number;
  openPositions: number;
  tradesToday: number;
  winStreak: number;
  marketsClosingToday: number;
  lastTradeAt: string | null;
  settledCount: number;
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
    winRate: 0,
    openPositions: 0,
    tradesToday: 0,
    winStreak: 0,
    marketsClosingToday: 0,
    lastTradeAt: null,
    settledCount: 0,
    loading: true,
  });

  const load = useCallback(async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    // May 1 2026 — only count calibrated trades; pre-May was development/uncalibrated
    const MAY_START = "2026-05-01T00:00:00.000Z";

    const [settledRes, openRes, placedTodayRes, strategiesRes, marketsRes] = await Promise.allSettled([
      // PnL comes from SETTLED trades only — filled trades have pnl=0 until resolution
      supabase
        .from("trades")
        .select("pnl, settled_at, mode")
        .eq("status", "settled")
        .gte("settled_at", MAY_START)
        .order("settled_at", { ascending: false })
        .limit(500),
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
      // Starting balance = sum of ALL strategy starting_balances (active or not — base must
      // include deactivated strategies whose historical trades still count toward P&L)
      supabase
        .from("strategies")
        .select("starting_balance"),
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
      ? parseFloat(((totalPnl / startingBalance) * 100).toFixed(1))
      : 0;

    // Today's P&L — trades that settled today
    const settledToday = modeTrades.filter(t => t.settled_at && t.settled_at >= todayISO);
    const todayPnl = settledToday.reduce((s, t) => s + (t.pnl ?? 0), 0);

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
      winRate,
      openPositions: openTrades.length,
      tradesToday,
      winStreak,
      marketsClosingToday,
      lastTradeAt: modeTrades[0]?.settled_at ?? null,
      settledCount: modeTrades.length,
      loading: false,
    });
  }, [mode]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel("dashboard-hero-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const { startingBalance, portfolioValue, totalReturn, totalReturnPct, todayPnl, winRate, openPositions, tradesToday, winStreak, marketsClosingToday, lastTradeAt, settledCount } = stats;
  const isUp = totalReturn >= 0;
  const isTodayUp = todayPnl >= 0;

  return (
    <div className="space-y-3 apple-reveal">
      {/* Hero card */}
      <div className="rounded-2xl bg-gradient-to-br from-card to-card/80 p-5 apple-shadow">

        {/* Top row: label + status */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {mode === "paper" ? "Portfolio" : "Live Portfolio"}
          </p>
          <AgentStatusBadge />
        </div>

        {/* Portfolio value — the number */}
        <h1
          className="text-[44px] font-light leading-none text-foreground"
          style={{ letterSpacing: "-0.04em" }}
        >
          {stats.loading
            ? <span className="text-muted-foreground">--</span>
            : `$${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
          {winStreak >= 3 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-warning/15 text-warning px-2 py-0.5 rounded-full">
              🔥 {winStreak} streak
            </span>
          )}
        </div>

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

        {/* Actions */}
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
            onClick={() => onNavigate?.("performance" as string)}
            className="flex items-center justify-center gap-1.5 h-10 rounded-xl bg-secondary hover:bg-secondary/70 text-xs font-medium text-foreground transition-all active:scale-95"
          >
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            Performance
          </button>
        </div>
      </div>

      {/* Status chips */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {lastTradeAt && (
          <AlertChip
            icon={<Bot className="h-3 w-3" />}
            label={`Last trade: ${timeAgo(lastTradeAt)}`}
            color="primary"
          />
        )}
        {marketsClosingToday > 0 && (
          <AlertChip
            icon={<Clock className="h-3 w-3" />}
            label={`${marketsClosingToday} market${marketsClosingToday === 1 ? "" : "s"} close today`}
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
