import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Cost constants (from CostReport) ──────────────────────────────────────────

const LLM_INPUT_PER_M = 0.15;
const LLM_OUTPUT_PER_M = 0.60;
const QUALIFY_INPUT_TOKENS = 1_200;
const QUALIFY_OUTPUT_TOKENS = 50;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComplianceEvent {
  id: string;
  created_at: string;
  event_type: string;
  severity: string;
  message: string;
  trade_id: string | null;
}

interface Trade {
  id: string;
  ticker: string | null;
  market_question: string | null;
  side: string;
  action: string;
  price: number;
  amount: number;
  strategy: string | null;
  mode: string | null;
  status: string;
  pnl: number | null;
  notes: string | null;
  filled_price: number | null;
  created_at: string;
  settled_at: string | null;
}

interface Strategy {
  id: string;
  name: string;
  active: boolean;
  mode: string;
  suspended_until: string | null;
  suspension_reason: string | null;
}

interface EquityPoint {
  date: string;
  cumPnl: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const SEVERITY_CLASSES: Record<string, string> = {
  info: "text-muted-foreground",
  warning: "text-yellow-500",
  error: "text-red-500",
  critical: "text-red-500 font-semibold",
};

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-muted-foreground/40",
  warning: "bg-yellow-500",
  error: "bg-red-500",
  critical: "bg-red-500",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  auto_trade_run: "Auto-Trade Run",
  auto_trade_strategy_run: "Strategy Run",
  auto_trade_strategy_error: "Strategy Error",
  auto_settle_run: "Auto-Settle",
  auto_reflect_run: "Auto-Reflect",
  surface_scan_complete: "Surface Scan",
  order_submitted: "Order Submitted",
  order_filled: "Order Filled",
  order_cancelled: "Order Cancelled",
  risk_check_passed: "Risk Check ✓",
  risk_check_failed: "Risk Check ✗",
  position_limit_hit: "Position Limit Hit",
  daily_loss_limit_hit: "Daily Loss Limit",
  strategy_suspended_sharpe: "Strategy Suspended (Sharpe)",
  strategy_suspended_drawdown: "Strategy Suspended (Drawdown)",
  strategy_suspended_hitrate: "Strategy Suspended (Hit Rate)",
  strategy_loss_streak: "Loss Streak",
  strategy_resumed: "Strategy Resumed",
  memory_quarantined: "Memory Quarantined",
  trade_settled: "Trade Settled",
};

function agentStatus(lastRunAt: string | null): {
  label: string;
  color: string;
  dot: string;
} {
  if (!lastRunAt)
    return { label: "Stale", color: "text-red-500", dot: "bg-red-500" };
  const minsAgo = (Date.now() - new Date(lastRunAt).getTime()) / 60000;
  if (minsAgo < 3)
    return {
      label: "Running",
      color: "text-emerald-500",
      dot: "bg-emerald-500",
    };
  if (minsAgo < 15)
    return { label: "Idle", color: "text-yellow-500", dot: "bg-yellow-500" };
  return { label: "Stale", color: "text-red-500", dot: "bg-red-500" };
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-card apple-shadow overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── ObservabilityPage ──────────────────────────────────────────────────────────

export default function ObservabilityPage() {
  const [liveIndicator, setLiveIndicator] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  // Hero state
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [openPositionCount, setOpenPositionCount] = useState(0);
  const [openPositionValue, setOpenPositionValue] = useState(0);
  const [todayPnl, setTodayPnl] = useState(0);
  const [heroFeed, setHeroFeed] = useState<ComplianceEvent[]>([]);
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());

  // Trace logs
  const [traceRuns, setTraceRuns] = useState<ComplianceEvent[]>([]);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [traceChildren, setTraceChildren] = useState<
    Record<string, ComplianceEvent[]>
  >({});
  const loadingTracesRef = useRef<Set<string>>(new Set());

  // Decision history
  const [decisionTrades, setDecisionTrades] = useState<Trade[]>([]);

  // Performance
  const [allSettledTrades, setAllSettledTrades] = useState<Trade[]>([]);
  const [equityData, setEquityData] = useState<EquityPoint[]>([]);

  // Cost / tools
  const [complianceLast30d, setComplianceLast30d] = useState<
    ComplianceEvent[]
  >([]);

  // Errors
  const [guardrailEvents, setGuardrailEvents] = useState<ComplianceEvent[]>(
    []
  );
  const [errorEvents, setErrorEvents] = useState<ComplianceEvent[]>([]);

  // System health
  const [strategies, setStrategies] = useState<Strategy[]>([]);

  // Pulse
  useEffect(() => {
    const t = setInterval(() => setLiveIndicator((v) => !v), 1200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.title = "Observability · TradeAgent";
    return () => {
      document.title = "TradeAgent";
    };
  }, []);

  // ── Data loaders ──────────────────────────────────────────────────────────

  const loadHeroStatus = useCallback(async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [lastRunRes, openRes, pnlRes] = await Promise.all([
      supabase
        .from("compliance_log")
        .select("created_at")
        .eq("event_type", "auto_trade_run")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("trades")
        .select("amount")
        .eq("status", "filled")
        .is("settled_at", null),
      supabase
        .from("trades")
        .select("pnl")
        .eq("status", "settled")
        .gte("settled_at", todayStart.toISOString()),
    ]);

    setLastRunAt(lastRunRes.data?.created_at ?? null);

    const openTrades: { amount: number }[] = openRes.data ?? [];
    setOpenPositionCount(openTrades.length);
    setOpenPositionValue(openTrades.reduce((s, t) => s + (t.amount ?? 0), 0));

    const pnlTrades: { pnl: number | null }[] = pnlRes.data ?? [];
    setTodayPnl(pnlTrades.reduce((s, t) => s + (t.pnl ?? 0), 0));
  }, []);

  const loadHeroFeed = useCallback(async () => {
    const { data } = await supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setHeroFeed(data as ComplianceEvent[]);
  }, []);

  const loadTraceLogs = useCallback(async () => {
    const { data } = await supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .eq("event_type", "auto_trade_run")
      .order("created_at", { ascending: false })
      .limit(20);
    if (data) setTraceRuns(data as ComplianceEvent[]);
  }, []);

  const loadDecisionHistory = useCallback(async () => {
    const { data } = await supabase
      .from("trades")
      .select(
        "id, ticker, market_question, side, action, price, amount, strategy, mode, status, pnl, notes, filled_price, created_at, settled_at"
      )
      .in("status", ["settled", "filled"])
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setDecisionTrades(data as Trade[]);
  }, []);

  const loadPerformance = useCallback(async () => {
    const { data } = await supabase
      .from("trades")
      .select("id, pnl, created_at, settled_at, status")
      .eq("status", "settled")
      .gte("settled_at", "2026-04-22T00:00:00.000Z")
      .order("settled_at", { ascending: true });
    if (data) {
      setAllSettledTrades(data as Trade[]);
      // Build equity curve
      let cum = 0;
      const pts: EquityPoint[] = (data as Trade[])
        .filter((t) => t.settled_at)
        .map((t) => {
          cum += t.pnl ?? 0;
          return { date: fmtShortDate(t.settled_at!), cumPnl: parseFloat(cum.toFixed(2)) };
        });
      setEquityData(pts);
    }
  }, []);

  const loadComplianceLast30d = useCallback(async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (data) setComplianceLast30d(data as ComplianceEvent[]);
  }, []);

  const loadErrors = useCallback(async () => {
    const guardrailTypes = [
      "risk_check_failed",
      "position_limit_hit",
      "daily_loss_limit_hit",
      "strategy_suspended_sharpe",
      "strategy_suspended_drawdown",
      "strategy_suspended_hitrate",
      "strategy_loss_streak",
      "memory_quarantined",
    ];

    const [guardrailRes, errorRes] = await Promise.all([
      supabase
        .from("compliance_log")
        .select("id, created_at, event_type, severity, message, trade_id")
        .in("event_type", guardrailTypes)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("compliance_log")
        .select("id, created_at, event_type, severity, message, trade_id")
        .in("severity", ["error", "critical"])
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (guardrailRes.data) setGuardrailEvents(guardrailRes.data as ComplianceEvent[]);
    if (errorRes.data) setErrorEvents(errorRes.data as ComplianceEvent[]);
  }, []);

  const loadStrategies = useCallback(async () => {
    const { data } = await supabase
      .from("strategies")
      .select("id, name, active, mode, suspended_until, suspension_reason");
    if (data) setStrategies(data as Strategy[]);
  }, []);

  // Session check + initial load
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsAuthenticated(!!session);
    });

    loadHeroStatus();
    loadHeroFeed();
    loadTraceLogs();
    loadDecisionHistory();
    loadPerformance();
    loadComplianceLast30d();
    loadErrors();
    loadStrategies();
  }, [
    loadHeroStatus,
    loadHeroFeed,
    loadTraceLogs,
    loadDecisionHistory,
    loadPerformance,
    loadComplianceLast30d,
    loadErrors,
    loadStrategies,
  ]);

  // Real-time
  useEffect(() => {
    const channel = supabase
      .channel("obs-realtime-v2")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "compliance_log" },
        (payload) => {
          const ev = payload.new as ComplianceEvent;
          // Hero feed
          setHeroFeed((prev) => [ev, ...prev.slice(0, 9)]);
          setNewEventIds((prev) => {
            const next = new Set(prev);
            next.add(ev.id);
            setTimeout(() => {
              setNewEventIds((s) => {
                const n = new Set(s);
                n.delete(ev.id);
                return n;
              });
            }, 2000);
            return next;
          });
          // Refresh trace list if it's a run
          if (ev.event_type === "auto_trade_run") {
            setTraceRuns((prev) => [ev, ...prev.slice(0, 19)]);
          }
          loadHeroStatus();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        () => {
          loadHeroStatus();
          loadDecisionHistory();
          loadPerformance();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadHeroStatus, loadDecisionHistory, loadPerformance]);

  // ── Trace expand ──────────────────────────────────────────────────────────

  const toggleTrace = useCallback(
    async (ev: ComplianceEvent) => {
      const id = ev.id;
      setExpandedTraces((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });

      // Lazy load children
      if (!traceChildren[id] && !loadingTracesRef.current.has(id)) {
        loadingTracesRef.current.add(id);
        const runAt = new Date(ev.created_at);
        const windowEnd = new Date(runAt.getTime() + 90 * 1000).toISOString();
        const { data } = await supabase
          .from("compliance_log")
          .select("id, created_at, event_type, severity, message, trade_id")
          .gt("created_at", ev.created_at)
          .lte("created_at", windowEnd)
          .neq("event_type", "auto_trade_run")
          .order("created_at", { ascending: true });
        setTraceChildren((prev) => ({
          ...prev,
          [id]: (data ?? []) as ComplianceEvent[],
        }));
        loadingTracesRef.current.delete(id);
      }
    },
    [traceChildren]
  );

  // ── Derived stats ─────────────────────────────────────────────────────────

  const status = agentStatus(lastRunAt);

  const minsAgo = lastRunAt
    ? Math.floor((Date.now() - new Date(lastRunAt).getTime()) / 60000)
    : null;

  // Performance stats
  const settledCount = allSettledTrades.length;
  const totalPnl = allSettledTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = allSettledTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = settledCount > 0 ? (wins / settledCount) * 100 : null;

  const durationsHours = allSettledTrades
    .filter((t) => t.settled_at)
    .map(
      (t) =>
        (new Date(t.settled_at!).getTime() - new Date(t.created_at).getTime()) /
        3600000
    );
  const avgDurationHours =
    durationsHours.length > 0
      ? durationsHours.reduce((s, v) => s + v, 0) / durationsHours.length
      : null;

  // All trades (for count)
  const totalTradeCount = decisionTrades.length; // approximation from loaded batch

  // Cost stats from compliance_last30d
  const tradesLast30d = complianceLast30d.filter(
    (e) => e.event_type === "order_submitted"
  ).length;

  const dailyLLMSpend =
    tradesLast30d > 0
      ? (tradesLast30d *
          1.5 *
          ((QUALIFY_INPUT_TOKENS / 1_000_000) * LLM_INPUT_PER_M +
            (QUALIFY_OUTPUT_TOKENS / 1_000_000) * LLM_OUTPUT_PER_M)) /
        30
      : 0;
  const avgTokensPerDecision = QUALIFY_INPUT_TOKENS + QUALIFY_OUTPUT_TOKENS;
  const costPerTrade =
    tradesLast30d > 0 ? (dailyLLMSpend * 30) / tradesLast30d : null;

  // Tool counts from compliance_last30d
  type EventCountMap = Record<string, number>;
  const eventCounts: EventCountMap = {};
  for (const e of complianceLast30d) {
    eventCounts[e.event_type] = (eventCounts[e.event_type] ?? 0) + 1;
  }

  const tools = [
    {
      name: "Market Scanner",
      desc: "Scans all open markets for edge opportunities",
      calls: eventCounts["surface_scan_complete"] ?? 0,
      errors: 0,
    },
    {
      name: "Strategy Engine",
      desc: "Evaluates signals per active strategy",
      calls: eventCounts["auto_trade_strategy_run"] ?? 0,
      errors: eventCounts["auto_trade_strategy_error"] ?? 0,
    },
    {
      name: "Order Execution",
      desc: "Submits orders to Kalshi REST API",
      calls: eventCounts["order_submitted"] ?? 0,
      errors: 0,
    },
    {
      name: "Settlement Engine",
      desc: "Resolves positions after market closes",
      calls: eventCounts["auto_settle_run"] ?? 0,
      errors: 0,
    },
    {
      name: "Memory & Learning",
      desc: "Reflects on trades and updates agent memory",
      calls: eventCounts["auto_reflect_run"] ?? 0,
      errors: 0,
    },
    {
      name: "Risk Guard",
      desc: "Checks position limits and daily loss caps",
      calls:
        (eventCounts["risk_check_passed"] ?? 0) +
        (eventCounts["risk_check_failed"] ?? 0),
      errors: eventCounts["risk_check_failed"] ?? 0,
    },
  ];

  const primaryMode = strategies[0]?.mode ?? "paper";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="frosted-glass sticky top-0 z-40 border-b border-border h-12 px-8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Bot className="h-4 w-4 text-foreground" />
          <span className="text-sm font-semibold tracking-tight">TradeAgent</span>
          <span className="text-muted-foreground/40 text-sm">·</span>
          <span className="text-sm text-muted-foreground">Observability</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full transition-opacity duration-500 ${
              liveIndicator ? "bg-emerald-500" : "bg-emerald-500/30"
            }`}
          />
          <span className="text-xs text-muted-foreground font-medium">Live</span>
        </div>
      </header>

      {/* ── Auth banner ──────────────────────────────────────────────────── */}
      {isAuthenticated === false && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-8 py-2.5 flex items-center justify-between">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            Sign in to see live event feed and agent memory.
          </span>
          <a
            href="/login?return=/observability"
            className="text-xs font-medium text-yellow-600 dark:text-yellow-400 underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            Sign in →
          </a>
        </div>
      )}

      <div className="max-w-[1100px] mx-auto px-8 py-6 space-y-6">

        {/* ── 1. Hero — Live Agent Status ──────────────────────────────── */}
        <section className="rounded-2xl bg-card apple-shadow overflow-hidden">
          <div className="grid grid-cols-3 divide-x divide-border">

            {/* LEFT: Status chip */}
            <div className="px-6 py-5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className={`h-3 w-3 rounded-full shrink-0 ${status.dot}`} />
                <span className={`text-2xl font-bold ${status.color}`}>
                  {status.label}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {minsAgo !== null
                  ? `Last heartbeat: ${minsAgo}m ago`
                  : "No heartbeat recorded"}
              </p>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground bg-secondary px-2 py-0.5 rounded-full w-fit">
                Mode: Paper
              </span>
            </div>

            {/* MIDDLE: Open positions + Today P&L */}
            <div className="px-6 py-5 flex flex-col justify-center gap-4">
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">
                  Open Positions
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {openPositionCount}
                  <span className="text-sm font-normal text-muted-foreground ml-1.5">
                    (${openPositionValue.toFixed(0)})
                  </span>
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">
                  Today's P&L
                </p>
                <p
                  className={`text-xl font-bold tabular-nums ${
                    todayPnl >= 0 ? "text-emerald-500" : "text-red-500"
                  }`}
                >
                  {todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}
                </p>
              </div>
            </div>

            {/* RIGHT: Real-time ticker */}
            <div className="px-6 py-5 flex flex-col gap-1 overflow-hidden">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1 shrink-0">
                Recent Events
              </p>
              <div className="space-y-1 overflow-hidden">
                {heroFeed.slice(0, 10).map((ev) => (
                  <div
                    key={ev.id}
                    className={`flex items-center gap-2 transition-colors duration-700 ${
                      newEventIds.has(ev.id) ? "text-emerald-500" : ""
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                        SEVERITY_DOT[ev.severity] ?? "bg-muted-foreground/40"
                      }`}
                    />
                    <span className="text-[11px] truncate flex-1 min-w-0">
                      {EVENT_TYPE_LABELS[ev.event_type] ?? ev.event_type}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
                      {relativeTime(ev.created_at)}
                    </span>
                  </div>
                ))}
                {heroFeed.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Waiting for events…
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ── 2. Trace Logs ────────────────────────────────────────────── */}
        <Section
          title="Execution Traces"
          action={
            <a
              href="https://cloud.langfuse.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
            >
              View in Langfuse
              <ExternalLink className="h-3 w-3" />
            </a>
          }
        >
          <div className="divide-y divide-border">
            {traceRuns.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No auto-trade runs found.
              </div>
            ) : (
              traceRuns.map((run) => {
                const isOpen = expandedTraces.has(run.id);
                const children = traceChildren[run.id];
                return (
                  <div key={run.id}>
                    <button
                      onClick={() => toggleTrace(run)}
                      className="w-full px-6 py-3 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-[140px]">
                        {fmtDate(run.created_at)}
                      </span>
                      <span className="text-[12px] font-medium shrink-0">
                        Auto-Trade Run
                      </span>
                      <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">
                        {run.message}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="bg-secondary/20 divide-y divide-border/50">
                        {!children ? (
                          <div className="px-10 py-2 text-[11px] text-muted-foreground">
                            Loading…
                          </div>
                        ) : children.length === 0 ? (
                          <div className="px-10 py-2 text-[11px] text-muted-foreground">
                            No child events within 90s.
                          </div>
                        ) : (
                          children.map((child) => (
                            <div
                              key={child.id}
                              className="px-10 py-2 flex items-start gap-2.5"
                            >
                              <span
                                className={`mt-[5px] h-1.5 w-1.5 rounded-full shrink-0 ${
                                  SEVERITY_DOT[child.severity] ??
                                  "bg-muted-foreground/40"
                                }`}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`text-[11px] font-medium ${
                                      SEVERITY_CLASSES[child.severity] ??
                                      "text-muted-foreground"
                                    }`}
                                  >
                                    {EVENT_TYPE_LABELS[child.event_type] ??
                                      child.event_type}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground/50 tabular-nums ml-auto shrink-0">
                                    {fmtTime(child.created_at)}
                                  </span>
                                </div>
                                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                                  {child.message}
                                </p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Section>

        {/* ── 3. Decision History ──────────────────────────────────────── */}
        <Section title="Decision History">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Time
                  </th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Market
                  </th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Action
                  </th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Size
                  </th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Strategy
                  </th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Entry
                  </th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    P&L
                  </th>
                  <th className="text-center px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {decisionTrades.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="text-center py-12 text-sm text-muted-foreground"
                    >
                      No trades found.
                    </td>
                  </tr>
                ) : (
                  decisionTrades.map((t) => {
                    const actionLabel = `${t.action?.toUpperCase()} ${t.side?.toUpperCase()}`;
                    const isBullish =
                      t.action === "buy" || t.side === "yes";
                    const label =
                      t.ticker ??
                      (t.market_question
                        ? t.market_question.slice(0, 40) +
                          (t.market_question.length > 40 ? "…" : "")
                        : "—");
                    const fullQ = t.market_question ?? t.ticker ?? "";
                    const hasPnl = t.pnl !== null;
                    const pnl = t.pnl ?? 0;

                    return (
                      <tr
                        key={t.id}
                        className="hover:bg-secondary/30 transition-colors"
                      >
                        <td className="px-6 py-2.5">
                          <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                            {fmtDate(t.created_at)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 max-w-[200px]">
                          <span
                            className="text-[12px] text-foreground"
                            title={fullQ}
                          >
                            {label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`text-[11px] font-semibold uppercase ${
                              isBullish ? "text-emerald-500" : "text-red-500"
                            }`}
                          >
                            {actionLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            ${t.amount?.toFixed(2) ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="text-[11px] text-muted-foreground">
                            {t.strategy ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {t.price}¢
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {hasPnl ? (
                            <span
                              className={`text-[12px] font-semibold tabular-nums ${
                                pnl >= 0 ? "text-emerald-500" : "text-red-500"
                              }`}
                            >
                              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Badge
                            variant="secondary"
                            className="text-[10px] rounded-full font-normal"
                          >
                            {t.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-2.5 max-w-[180px]">
                          {t.notes ? (
                            <span
                              className="text-[11px] text-muted-foreground truncate block"
                              title={t.notes}
                            >
                              {t.notes.slice(0, 50)}
                              {t.notes.length > 50 ? "…" : ""}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── 4. Performance ───────────────────────────────────────────── */}
        <Section title="Performance">
          <div className="grid grid-cols-2 gap-0 divide-x divide-border">

            {/* Stat cards 2×2 */}
            <div className="p-6 grid grid-cols-2 gap-4">
              <StatCard
                label="Total P&L"
                value={
                  <span
                    className={
                      totalPnl >= 0 ? "text-emerald-500" : "text-red-500"
                    }
                  >
                    {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                  </span>
                }
              />
              <StatCard
                label="Win Rate"
                value={
                  winRate !== null ? (
                    <span
                      className={
                        winRate >= 55
                          ? "text-emerald-500"
                          : winRate >= 40
                          ? "text-yellow-500"
                          : "text-red-500"
                      }
                    >
                      {winRate.toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
                sub={settledCount > 0 ? `${wins}/${settledCount} settled` : undefined}
              />
              <StatCard
                label="Total Trades"
                value={<span>{settledCount}</span>}
                sub="settled"
              />
              <StatCard
                label="Avg Duration"
                value={
                  avgDurationHours !== null ? (
                    <span>{avgDurationHours.toFixed(1)}h</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
                sub="entry → settle"
              />
            </div>

            {/* Equity curve */}
            <div className="p-6">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-3">
                Equity Curve
              </p>
              {equityData.length < 2 ? (
                <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                  Not enough data yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={equityData}>
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v}`}
                    />
                    <Tooltip
                      formatter={(value: number) => [`$${value.toFixed(2)}`, "Cum. P&L"]}
                      contentStyle={{
                        fontSize: 11,
                        borderRadius: 8,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="cumPnl"
                      stroke="hsl(var(--primary))"
                      fill="hsl(var(--primary))"
                      fillOpacity={0.1}
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </Section>

        {/* ── 5. Cost & Efficiency ─────────────────────────────────────── */}
        <Section title="Cost & Efficiency">
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-xl border border-border p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
                  Daily LLM Spend
                </p>
                <p className="text-xl font-bold tabular-nums">
                  ${dailyLLMSpend.toFixed(4)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  gpt-4o-mini via OpenRouter
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
                  Tokens / Decision
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {avgTokensPerDecision.toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {QUALIFY_INPUT_TOKENS.toLocaleString()} in +{" "}
                  {QUALIFY_OUTPUT_TOKENS} out
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
                  Cost per Trade
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {costPerTrade !== null
                    ? costPerTrade < 0.0001
                      ? "<$0.0001"
                      : `$${costPerTrade.toFixed(4)}`
                    : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {tradesLast30d} orders last 30d
                </p>
              </div>
            </div>

            {/* Tools table */}
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-3">
                Agent Tools
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 text-[11px] font-medium text-muted-foreground">
                      Tool
                    </th>
                    <th className="text-left py-2 text-[11px] font-medium text-muted-foreground">
                      What it does
                    </th>
                    <th className="text-right py-2 text-[11px] font-medium text-muted-foreground">
                      Calls (30d)
                    </th>
                    <th className="text-right py-2 text-[11px] font-medium text-muted-foreground">
                      Errors (30d)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tools.map((tool) => (
                    <tr key={tool.name} className="hover:bg-secondary/20 transition-colors">
                      <td className="py-2.5 text-[12px] font-medium">
                        {tool.name}
                      </td>
                      <td className="py-2.5 text-[11px] text-muted-foreground">
                        {tool.desc}
                      </td>
                      <td className="py-2.5 text-right text-[12px] tabular-nums">
                        {tool.calls.toLocaleString()}
                      </td>
                      <td className="py-2.5 text-right text-[12px] tabular-nums">
                        {tool.errors > 0 ? (
                          <span className="text-red-500">{tool.errors}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        {/* ── 6. Errors & Rough Edges ──────────────────────────────────── */}
        <Section
          title="Errors & Rough Edges"
          action={
            <span className="text-[10px] text-muted-foreground italic">
              not hidden — this is how the system learns
            </span>
          }
        >
          <div className="divide-y divide-border">
            {/* Guardrails fired */}
            <div className="px-6 py-4">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-3">
                Guardrails Fired
              </p>
              {guardrailEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No guardrail events.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-border">
                    {guardrailEvents.map((ev) => (
                      <tr key={ev.id} className="hover:bg-secondary/20 transition-colors">
                        <td className="py-2 text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pr-4 w-[140px]">
                          {fmtDate(ev.created_at)}
                        </td>
                        <td className="py-2 text-[11px] font-medium pr-4 w-[200px]">
                          {EVENT_TYPE_LABELS[ev.event_type] ?? ev.event_type}
                        </td>
                        <td className="py-2 text-[11px] text-muted-foreground flex-1">
                          {ev.message}
                        </td>
                        <td className="py-2 text-right pl-4">
                          <span
                            className={`text-[10px] font-medium ${
                              SEVERITY_CLASSES[ev.severity] ??
                              "text-muted-foreground"
                            }`}
                          >
                            {ev.severity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Recent errors */}
            <div className="px-6 py-4">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-3">
                Recent Errors
              </p>
              {errorEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No errors in the log.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-border">
                    {errorEvents.map((ev) => (
                      <tr key={ev.id} className="hover:bg-secondary/20 transition-colors">
                        <td className="py-2 text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pr-4 w-[140px]">
                          {fmtDate(ev.created_at)}
                        </td>
                        <td className="py-2 text-[11px] font-medium pr-4 w-[200px]">
                          {EVENT_TYPE_LABELS[ev.event_type] ?? ev.event_type}
                        </td>
                        <td className="py-2 text-[11px] text-muted-foreground flex-1">
                          {ev.message}
                        </td>
                        <td className="py-2 text-right pl-4">
                          <span
                            className={`text-[10px] font-medium ${
                              SEVERITY_CLASSES[ev.severity] ??
                              "text-muted-foreground"
                            }`}
                          >
                            {ev.severity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </Section>

        {/* ── 7. System Health ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 pb-4">
          <SystemPill
            label="Trading Mode"
            value={primaryMode.charAt(0).toUpperCase() + primaryMode.slice(1)}
            valueClass={
              primaryMode === "live" ? "text-emerald-500" : "text-yellow-500"
            }
          />
          <SystemPill label="LLM" value="gpt-4o-mini via OpenRouter" />
          <SystemPill label="Functions" value="7 edge functions" />
          <a
            href="https://cloud.langfuse.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs bg-secondary px-3 py-1.5 rounded-full hover:bg-secondary/80 transition-colors"
          >
            <span className="text-muted-foreground">Langfuse:</span>
            <span className="font-medium">LLM traces ↗</span>
          </a>
        </div>

      </div>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
        {label}
      </p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {sub && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
      )}
    </div>
  );
}

// ── SystemPill ────────────────────────────────────────────────────────────────

function SystemPill({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-secondary px-3 py-1.5 rounded-full">
      <span className="text-[10px] text-muted-foreground">{label}:</span>
      <span className={`text-[10px] font-medium ${valueClass}`}>{value}</span>
    </div>
  );
}
