import { Bot, Clock } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { fetchKalshiMarkets } from "@/lib/kalshiApi";

const PAPER_STARTING = 10_000;

interface HeroStats {
  portfolioValue: number;
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
    portfolioValue: PAPER_STARTING,
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

    const [tradesRes, recentRes, marketsRes] = await Promise.allSettled([
      supabase
        .from("trades")
        .select("pnl, created_at, status, mode")
        .eq("status", "filled")
        .order("created_at", { ascending: false }),
      supabase
        .from("trades")
        .select("pnl")
        .eq("status", "filled")
        .order("created_at", { ascending: false })
        .limit(10),
      fetchKalshiMarkets(200),
    ]);

    const allTrades = tradesRes.status === "fulfilled" ? (tradesRes.value.data ?? []) : [];
    const recentTrades = recentRes.status === "fulfilled" ? (recentRes.value.data ?? []) : [];
    const markets = marketsRes.status === "fulfilled" ? marketsRes.value : [];

    // Filter by mode
    const modeTrades = mode ? allTrades.filter(t => t.mode === mode) : allTrades;

    // Portfolio value: starting balance + total PnL
    const totalPnl = modeTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const portfolioValue = PAPER_STARTING + totalPnl;

    // Today's PnL
    const todayTrades = modeTrades.filter(t => t.created_at >= todayISO);
    const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const todayPnlPct = portfolioValue > 0
      ? parseFloat(((todayPnl / (portfolioValue - todayPnl)) * 100).toFixed(2))
      : 0;

    // Win rate
    const pnls = modeTrades.map(t => t.pnl ?? 0);
    const winners = pnls.filter(p => p > 0).length;
    const losers = pnls.filter(p => p < 0).length;
    const winRate = winners + losers > 0 ? Math.round((winners / (winners + losers)) * 100) : 0;

    // Open positions (trades today not yet settled — simplified as all today's trades)
    const openPositions = modeTrades.filter(
      t => t.status === "filled" && t.created_at >= todayISO
    ).length;

    // Trades today
    const tradesToday = todayTrades.length;

    // Win streak from most recent trades
    let winStreak = 0;
    for (const t of recentTrades) {
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
      portfolioValue,
      todayPnl,
      todayPnlPct,
      winRate,
      openPositions,
      tradesToday,
      winStreak,
      marketsClosingToday,
      loading: false,
    });
  }, [mode]);

  useEffect(() => { load(); }, [load]);

  const { portfolioValue, todayPnl, todayPnlPct, winRate, openPositions, tradesToday, winStreak, marketsClosingToday } = stats;
  const isUp = todayPnl >= 0;

  return (
    <div className="space-y-3 apple-reveal">
      {/* Hero card */}
      <div className="rounded-2xl bg-card p-5 apple-shadow">
        {/* Label row */}
        <div className="flex items-start justify-between mb-1 gap-2">
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-widest">
            {mode === "paper" ? "Your Paper Portfolio" : mode === "live" ? "Your Portfolio" : "Your Portfolio"}
          </p>
          <AgentStatusBadge />
        </div>

        {/* Giant P&L value */}
        <h1
          className="text-[42px] font-light leading-none text-foreground mb-2"
          style={{ letterSpacing: "-0.03em" }}
        >
          ${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </h1>

        {/* Today's change + streak */}
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <span className={cn("text-base font-medium tabular-nums", isUp ? "text-profit" : "text-loss")}>
            {isUp ? "+" : ""}${Math.abs(todayPnl).toFixed(2)}
          </span>
          <span className={cn("text-sm", isUp ? "text-profit" : "text-loss")}>
            ({isUp ? "+" : ""}{todayPnlPct}% today)
          </span>
          {winStreak >= 3 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-warning/15 text-warning px-2.5 py-0.5 rounded-full animate-pulse-gentle">
              🔥 {winStreak} streak
            </span>
          )}
        </div>

        {/* 4-up quick stats */}
        <div className="grid grid-cols-4 gap-2">
          <QuickStat
            label="Win Rate"
            value={winRate > 0 ? `${winRate}%` : "--"}
            color={winRate > 0 ? (winRate >= 50 ? "profit" : "loss") : undefined}
            progress={winRate > 0 ? winRate : undefined}
          />
          <QuickStat label="Today" value={tradesToday > 0 ? `${tradesToday} tr` : "0 tr"} />
          <QuickStat label="Open" value={openPositions > 0 ? `${openPositions} pos` : "0 pos"} />
          <QuickStat
            label="Mode"
            value={mode === "live" ? "Live" : "Paper"}
            color={mode === "live" ? "loss" : "primary"}
          />
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
