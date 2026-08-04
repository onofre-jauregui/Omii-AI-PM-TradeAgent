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

// How long a successful Kalshi wallet ping stays fresh. Within this window we reuse
// the cached balance instead of re-hitting kalshi-ping, so the balance doesn't re-fetch
// on every unrelated `trades` realtime event.
const KALSHI_PING_TTL_MS = 15_000;

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
  /** Set when a load threw. The card renders its last-known numbers with a
   *  retry affordance instead of an eternal spinner — a failed refresh must be
   *  visible and recoverable, never silent. */
  loadError?: boolean;
  /** The mode these stats were computed for. Used to reject cross-mode renders
   *  so the live tab never briefly shows paper numbers (or vice versa). */
  statsMode?: "paper" | "live";
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
  const modeRef = useRef(mode); // latest mode — used to discard cross-mode stale loads
  modeRef.current = mode;
  const lastKalshiBalanceRef = useRef<number | null>(null); // last known-good wallet balance
  const lastKalshiPingRef = useRef(0); // ts of last successful Kalshi ping (throttle window)
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
    try {
      // Hard ceiling on the whole load. supabase-js attaches no timeout to its
      // fetches, so a single stalled PostgREST socket inside Promise.allSettled
      // never settles — allSettled cannot reject, so there is no throw to catch
      // and the spinner stays up forever. A timeout converts "hangs silently"
      // into "fails visibly", which the catch below can actually act on.
      await Promise.race([
        loadInner(myId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("dashboard load timed out after 20s")), 20_000)
        ),
      ]);
    } catch (err) {
      // Never leave the hero pinned on a spinner. `loading:false` used to be
      // written in exactly one place — the final setStats, behind every await —
      // so any throw between here and there (a rejected auth.getSession, a
      // stalled PostgREST socket, a hung kalshi-ping body) hid the whole
      // dashboard permanently with no error and no retry. That is what took
      // production down on 2026-08-04, live mode only, because paper mode
      // short-circuits the wallet ping.
      console.error("DashboardHero load failed:", err);
      if (myId !== loadIdRef.current) return;
      // statsMode MUST be stamped here. The rendered flag is
      //   loading = stats.loading || stats.statsMode !== mode
      // so clearing `stats.loading` alone still leaves the spinner up whenever
      // statsMode is stale — which it always is on a mode switch, since only a
      // successful commit ever writes it. Paper hung for exactly this reason:
      // the last load in a burst failed, and the card had no way back.
      setStats((prev) => ({
        ...prev,
        loading: false,
        loadError: true,
        statsMode: modeRef.current,
      }));
    }
  }, [mode, userIdProp]);

  const loadInner = useCallback(async (myId: number) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    const MAY_START = "2026-04-22T00:00:00.000Z";

    // Use prop if available — avoids a network round-trip on every load
    const userId = userIdProp ?? (await supabase.auth.getUser()).data.user?.id;

    // Fetch Kalshi wallet balance when in live mode (non-blocking — may fail if no key set).
    // Two guards prevent a 2600 → 0 → 2600 flicker: (1) within KALSHI_PING_TTL_MS we reuse the
    // cached balance instead of re-pinging on every unrelated trades realtime event; (2) a transient
    // failure (non-ok, missing balance, or throw) returns the last known-good value rather than null,
    // so displayValue never falls back to the empty-live portfolioValue (0) after a good read.
    const kalshiBalanceFetch: Promise<number | null> = mode === "live"
      ? (Date.now() - lastKalshiPingRef.current < KALSHI_PING_TTL_MS
          ? Promise.resolve(lastKalshiBalanceRef.current)
          : supabase.auth.getSession().then(({ data }) => {
              const session = data?.session;
              if (!session) return lastKalshiBalanceRef.current;
              const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kalshi-ping`;
              const ctrl = new AbortController();
              // Hold the abort until the BODY is parsed, not just until headers
              // arrive. Clearing it at the header stage left r.json() completely
              // unguarded, so a stalled response body hung forever — and
              // kalshi-ping worst-cases around 16s server-side (8s credential
              // race + 8s Kalshi fetch) with an unguarded auth.getUser() on top.
              const pingTimeout = setTimeout(() => ctrl.abort(), 8000);
              return fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` }, signal: ctrl.signal })
                .then(r => (r.ok ? r.json() : null))
                .then(j => {
                  const bal = j?.balance_usd != null ? Number(j.balance_usd) : null;
                  if (bal != null) {
                    lastKalshiBalanceRef.current = bal;
                    lastKalshiPingRef.current = Date.now();
                  }
                  return bal ?? lastKalshiBalanceRef.current; // keep last-good on transient failure
                })
                .catch(() => lastKalshiBalanceRef.current)
                .finally(() => clearTimeout(pingTimeout));
            })
            // getSession() itself can reject, and the destructure of a missing
            // `data` throws — neither was caught, so the rejection propagated
            // out of the awaited wallet fetch and killed the entire render.
            // The wallet is decoration; it must never gate the dashboard.
            .catch(() => lastKalshiBalanceRef.current))
      : Promise.resolve(null);

    const [settledRes, openRes, placedTodayRes, strategiesRes, lastPlacedRes] = await Promise.allSettled([
      // PnL comes from SETTLED trades only — filled trades have pnl=0 until resolution
      supabase
        .from("trades")
        .select("pnl, net_pnl, settled_at, mode")
        .eq("status", "settled")
        .eq("user_id", userId ?? "")
        .gte("settled_at", MAY_START)
        .order("settled_at", { ascending: false })
        .limit(2000),
      // Open positions: filled but not yet settled (mode-scoped so the live tab
      // doesn't count paper positions)
      (() => {
        let q = supabase
          .from("trades")
          .select("id, ticker")
          .eq("status", "filled")
          .eq("user_id", userId ?? "")
          .is("settled_at", null);
        if (mode) q = q.eq("mode", mode);
        return q;
      })(),
      // Trades placed today (for activity count) — mode-scoped
      (() => {
        let q = supabase
          .from("trades")
          .select("id")
          .eq("user_id", userId ?? "")
          .gte("created_at", todayISO);
        if (mode) q = q.eq("mode", mode);
        return q;
      })(),
      // Starting balance — sum of strategies matching the current mode
      (() => {
        let q = supabase.from("strategies").select("starting_balance, mode").eq("user_id", userId ?? "");
        if (mode) q = q.eq("mode", mode);
        return q;
      })(),
      // Most recently SETTLED trade — "Last settled" chip. Mode-scoped so the live tab
      // doesn't surface a paper settlement while live P&L reads empty.
      (() => {
        // NOT NULL is load-bearing: Postgres orders DESC with NULLS FIRST, so a
        // single settled row carrying a null settled_at wins limit(1) and the
        // "Last settled" chip silently disappears, replaced by the misleading
        // "Agent scanning — first trades appear within 30 min". Exactly what the
        // 2026-08-04 repair pass produced when it nulled settled_at on 146 rows.
        let q = supabase
          .from("trades")
          .select("settled_at")
          .eq("user_id", userId ?? "")
          .eq("status", "settled")
          .not("settled_at", "is", null)
          .order("settled_at", { ascending: false })
          .limit(1);
        if (mode) q = q.eq("mode", mode);
        return q;
      })(),
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
    // net_pnl is the fee-inclusive, Kalshi-reconciled figure (reconcile-ledger).
    // Falling back to gross pnl keeps rows predating reconciliation readable.
    // Reading gross here is what made the wallet card disagree with the exchange.
    const realised = (t: { pnl?: number | null; net_pnl?: number | null }) =>
      (t.net_pnl ?? t.pnl ?? 0);
    const totalPnl = modeTrades.reduce((s, t) => s + realised(t), 0);
    const portfolioValue = startingBalance + totalPnl;
    const totalReturnPct = startingBalance > 0
      ? parseFloat(((totalPnl / startingBalance) * 100).toFixed(1))
      : 0;

    // Today's P&L — trades that settled today
    const settledToday = modeTrades.filter(t => t.settled_at && t.settled_at >= todayISO);
    const todayPnl = settledToday.reduce((s, t) => s + realised(t), 0);

    // Win rate across all settled trades
    const winners = modeTrades.filter(t => realised(t) > 0).length;
    const losers = modeTrades.filter(t => realised(t) < 0).length;
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
      byDay[day] = (byDay[day] ?? 0) + realised(t);
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

    // Discard if a newer load fired OR the mode changed while this load was in
    // flight. The second check kills the flicker: a paper-scoped load triggered
    // by a realtime `trades` event can otherwise resolve after the user is on the
    // live tab and overwrite the live numbers with the paper portfolio.
    if (myId !== loadIdRef.current || mode !== modeRef.current) return;
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
      loadError: false,
      statsMode: mode,
    });
  }, [mode, userIdProp]);

  useEffect(() => {
    load();
    // Debounced, mirroring strategiesContext. Unthrottled, this fired a full
    // reload (5 PostgREST queries + a kalshi-ping) per row event: the
    // 2026-08-04 ledger reconciliation wrote ~177 rows in a burst and produced
    // ~900 requests. Only the newest load may commit (loadIdRef), and every
    // superseded one returns early WITHOUT clearing `loading` — so a burst
    // reliably ended on a load that was throttled or aborted, leaving the
    // spinner up for good. reconcile-ledger-hourly reproduces that burst every
    // hour at :20, so this is a permanent hazard, not a one-off.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const ch = supabase
      .channel("dashboard-hero-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { load(); }, 500);
      })
      .subscribe();
    return () => { clearTimeout(debounce); supabase.removeChannel(ch); };
  }, [load]);

  // Lazy-load Kalshi markets after initial render — primes cache, then re-runs load()
  // so marketsClosingToday is computed without blocking the hero's first paint.
  // load is in deps so the closure is always fresh — a stale closure here wins the
  // loadIdRef race and discards valid live-mode results.
  useEffect(() => {
    let cancelled = false;
    getCachedKalshiMarkets().then(markets => {
      if (!cancelled && markets.length > 0) load();
    });
    return () => { cancelled = true; };
  }, [load]);

  const { startingBalance, portfolioValue, kalshiBalance, totalReturn, totalReturnPct, todayPnl, winRate, openPositions, tradesToday, winStreak, marketsClosingToday, lastTradeAt, settledCount } = stats;
  const isUp = totalReturn >= 0;
  const isTodayUp = todayPnl >= 0;
  const displayValue = mode === "live" && kalshiBalance != null ? kalshiBalance : portfolioValue;
  const isLiveWallet = mode === "live" && kalshiBalance != null;
  // While a mode switch is settling, `stats` may still describe the other mode.
  // Treat that as loading so no cross-mode number (e.g. the paper portfolio on
  // the live tab) is ever rendered.
  const loading = stats.loading || stats.statsMode !== mode;

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
          {/* A refresh that failed must say so and offer a way back. Silently
              showing the previous load's numbers is how a stale figure gets
              mistaken for a current one. */}
          {stats.loadError && (
            <button
              onClick={() => load()}
              className="inline-flex items-center gap-1 text-xs font-medium text-warning bg-warning/10 px-2 py-0.5 rounded-full"
            >
              Couldn't refresh — retry
            </button>
          )}
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
        {!loading && stats.chartPoints.length > 2 && (
          <div className="my-3 -mx-1">
            <ResponsiveContainer width="100%" height={100}>
              <AreaChart data={stats.chartPoints} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
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
            value={loading ? "--" : winRate > 0 ? `${winRate}%` : "--"}
            color={!loading && winRate > 0 ? (winRate >= 50 ? "profit" : "loss") : undefined}
            progress={!loading && winRate > 0 ? winRate : undefined}
          />
          <QuickStat
            label="Settled"
            value={loading ? "--" : settledCount > 0 ? `${settledCount}` : "0"}
          />
          <QuickStat
            label="Open"
            value={loading ? "--" : openPositions > 0 ? `${openPositions}` : "0"}
            color={!loading && openPositions > 0 ? "primary" : undefined}
          />
          <QuickStat
            label="Today"
            value={loading ? "--" : tradesToday > 0 ? `${tradesToday}` : "0"}
            color={!loading && tradesToday > 0 ? "profit" : undefined}
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
