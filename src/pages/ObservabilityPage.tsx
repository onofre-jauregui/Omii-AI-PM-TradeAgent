import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
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

interface MemoryEntry {
  id: string;
  memory_type: string;
  title: string;
  content: string;
  confidence: number;
  exposed_confidence: number | null;
  confirmations: number;
  contradictions: number;
  is_active: boolean;
  tags: string[] | null;
  strategy_id: string | null;
  source_type: string;
  scope: string | null;
  trade_sample_size: number;
  created_at: string;
  last_recalled_at: string | null;
  quarantined_at: string | null;
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

const ERROR_SUMMARIES: Record<string, string> = {
  risk_check_failed: "The agent attempted a trade that failed pre-flight risk checks. The position was blocked before any order was submitted to Kalshi.",
  position_limit_hit: "The agent reached the maximum number of concurrent open positions. New entries are blocked until existing positions settle or are exited.",
  daily_loss_limit_hit: "Cumulative realized losses for the day exceeded the configured daily loss limit. All trading was halted for the remainder of the session.",
  strategy_suspended_sharpe: "This strategy's Sharpe ratio dropped below the minimum threshold (−1.0) over its last 20 trades. It was automatically suspended for 24 hours.",
  strategy_suspended_drawdown: "The strategy's drawdown exceeded the user-configured maximum. Automatically suspended for 24 hours to prevent further capital erosion.",
  strategy_suspended_hitrate: "Win rate dropped more than 20 percentage points below the strategy's expected rate over 20 trades. Suspended for 72 hours.",
  strategy_loss_streak: "The strategy recorded 5 or more consecutive losing trades. A soft warning was logged — no suspension triggered yet.",
  memory_quarantined: "An agent memory entry's exposed confidence dropped below 0.30 after 10+ attributed trades. It has been removed from the LLM context window.",
  auto_trade_strategy_error: "An unexpected error occurred inside a strategy execution block. The error was caught, logged, and the run continued with remaining strategies.",
};

const ERROR_RESOLUTIONS: Record<string, string> = {
  risk_check_failed: "Review position sizing, max concurrent positions, and daily loss limits in the Risk Controls panel. If the trade was valid, consider relaxing the relevant limit.",
  position_limit_hit: "Wait for open positions to settle naturally, or manually close positions via the Agent tab. Adjust the max concurrent positions setting if needed.",
  daily_loss_limit_hit: "Trading will auto-resume the next day. If this is happening frequently, review strategy filters or reduce per-trade size.",
  strategy_suspended_sharpe: "Wait for the 24-hour suspension to lift. Review recent losing trades in Decision History to identify the root cause before the strategy resumes.",
  strategy_suspended_drawdown: "Strategy auto-resumes after 24 hours. Consider tightening entry criteria or reducing allocation to this strategy.",
  strategy_suspended_hitrate: "72-hour suspension is active. Review whether market conditions have shifted and whether the strategy's signal logic needs updating.",
  strategy_loss_streak: "Monitor the next few trades closely. If losses continue, the strategy will be suspended automatically. Consider pausing it manually if the edge looks gone.",
  memory_quarantined: "No action needed — this is the self-correction system working. The memory had low predictive value and was removed. It can be re-promoted if confidence recovers.",
  auto_trade_strategy_error: "Check the Supabase Edge Function logs for the full stack trace. Common causes: Kalshi API timeout, missing market data, or an unexpected null in signal data.",
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

const MEMORY_TYPE_COLORS: Record<string, string> = {
  lesson:           "bg-blue-500/10 text-blue-500",
  pattern:          "bg-purple-500/10 text-purple-500",
  mistake:          "bg-red-500/10 text-red-500",
  success:          "bg-emerald-500/10 text-emerald-500",
  market_note:      "bg-yellow-500/10 text-yellow-500",
  strategy_insight: "bg-orange-500/10 text-orange-500",
};

const MEMORY_TYPE_LABELS: Record<string, string> = {
  lesson: "Lesson", pattern: "Pattern", mistake: "Mistake",
  success: "Success", market_note: "Market Note", strategy_insight: "Strategy Insight",
};

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
  const [traceDay, setTraceDay] = useState<string>(() => {
    return new Date().toISOString().slice(0, 10);
  });

  // Decision history
  const [decisionTrades, setDecisionTrades] = useState<Trade[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [selectedError, setSelectedError] = useState<ComplianceEvent | null>(null);
  const [decisionDateFilter, setDecisionDateFilter] = useState<"today" | "7d" | "30d" | "all">("30d");
  const [decisionStatusFilter, setDecisionStatusFilter] = useState<"all" | "filled" | "settled">("all");

  // Performance
  const [allSettledTrades, setAllSettledTrades] = useState<Trade[]>([]);
  const [equityData, setEquityData] = useState<EquityPoint[]>([]);

  // Cost / tools
  const [complianceLast30d, setComplianceLast30d] = useState<ComplianceEvent[]>([]);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [tradesLast30dCount, setTradesLast30dCount] = useState(0);
  const [avgCycleMs, setAvgCycleMs] = useState<number | null>(null);

  // Errors
  const [guardrailEvents, setGuardrailEvents] = useState<ComplianceEvent[]>(
    []
  );
  const [errorEvents, setErrorEvents] = useState<ComplianceEvent[]>([]);

  // System health
  const [strategies, setStrategies] = useState<Strategy[]>([]);

  // Memory
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryTypeFilter, setMemoryTypeFilter] = useState<string>("all");
  const [memorySortBy, setMemorySortBy] = useState<"confidence" | "confirmations" | "newest">("confidence");
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);

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
        .in("event_type", ["auto_trade_run", "auto_trade_skipped"])
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
    const dayStart = new Date(traceDay + "T00:00:00.000Z").toISOString();
    const dayEnd   = new Date(traceDay + "T23:59:59.999Z").toISOString();
    const { data } = await supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .eq("event_type", "auto_trade_run")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: false })
      .limit(200);
    if (data) setTraceRuns(data as ComplianceEvent[]);
  }, [traceDay]);

  const loadDecisionHistory = useCallback(async (
    dateFilter: "today" | "7d" | "30d" | "all" = "30d",
    statusFilter: "all" | "filled" | "settled" = "all"
  ) => {
    let query = supabase
      .from("trades")
      .select("id, ticker, market_question, side, action, price, amount, strategy, mode, status, pnl, notes, filled_price, created_at, settled_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (statusFilter === "filled") {
      query = query.eq("status", "filled");
    } else if (statusFilter === "settled") {
      query = query.eq("status", "settled");
    } else {
      query = query.in("status", ["settled", "filled"]);
    }

    if (dateFilter === "today") {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      query = query.gte("created_at", todayStart.toISOString());
    } else if (dateFilter === "7d") {
      query = query.gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());
    } else if (dateFilter === "30d") {
      query = query.gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    }

    const { data } = await query;
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

    // Event types that actually exist in compliance_log (verified from edge function source)
    const toolEventTypes = [
      "surface_scan_complete",
      "auto_trade_run",
      "auto_trade_strategy_run",   // 1 LLM qualify call per strategy per run
      "auto_trade_strategy_error",
      "basket_completed",           // order sent to Kalshi (not "order_submitted")
      "order_cancelled",
      "auto_settle_run",
      "auto_reflect_run",
      "auto_trade_skipped",        // risk/filter guard blocks
      "strategy_auto_halted",
    ];

    const [eventsRes, tradesCountRes, ...countResults] = await Promise.all([
      supabase
        .from("compliance_log")
        .select("id, created_at, event_type, severity, message, trade_id")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("trades")
        .select("*", { count: "exact", head: true })
        .gte("created_at", since),
      ...toolEventTypes.map((et) =>
        supabase
          .from("compliance_log")
          .select("*", { count: "exact", head: true })
          .eq("event_type", et)
          .gte("created_at", since)
      ),
    ]);

    if (eventsRes.data) setComplianceLast30d(eventsRes.data as ComplianceEvent[]);
    setTradesLast30dCount(tradesCountRes.count ?? 0);

    const counts: Record<string, number> = {};
    toolEventTypes.forEach((et, i) => {
      counts[et] = countResults[i].count ?? 0;
    });
    setToolCounts(counts);
  }, []);

  const loadModelLatency = useCallback(async () => {
    // Fetch last 8 auto_trade_run events
    const { data: runs } = await supabase
      .from("compliance_log")
      .select("id, created_at")
      .eq("event_type", "auto_trade_run")
      .order("created_at", { ascending: false })
      .limit(8);
    if (!runs || runs.length === 0) return;

    // For each run, find the last child event within 90s
    const deltas: number[] = [];
    await Promise.all(
      runs.map(async (run) => {
        const windowEnd = new Date(new Date(run.created_at).getTime() + 90_000).toISOString();
        const { data: children } = await supabase
          .from("compliance_log")
          .select("created_at")
          .gt("created_at", run.created_at)
          .lte("created_at", windowEnd)
          .neq("event_type", "auto_trade_run")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (children) {
          const ms = new Date(children.created_at).getTime() - new Date(run.created_at).getTime();
          if (ms > 0) deltas.push(ms);
        }
      })
    );

    if (deltas.length > 0) {
      setAvgCycleMs(Math.round(deltas.reduce((s, v) => s + v, 0) / deltas.length));
    }
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
      "auto_trade_strategy_error",
    ];

    const [guardrailRes, errorRes] = await Promise.all([
      supabase
        .from("compliance_log")
        .select("id, created_at, event_type, severity, message, trade_id")
        .in("event_type", guardrailTypes)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("compliance_log")
        .select("id, created_at, event_type, severity, message, trade_id")
        .in("severity", ["error", "critical", "warning"])
        .order("created_at", { ascending: false })
        .limit(30),
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

  const loadMemories = useCallback(async () => {
    const { data } = await (supabase.from("agent_memory" as any) as any)
      .select("id, memory_type, title, content, confidence, exposed_confidence, confirmations, contradictions, is_active, tags, strategy_id, source_type, scope, trade_sample_size, created_at, last_recalled_at, quarantined_at")
      .order("confidence", { ascending: false })
      .limit(200);
    if (data) setMemories(data as MemoryEntry[]);
  }, []);

  // Session check + initial load
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsAuthenticated(!!session);
    });

    loadHeroStatus();
    loadHeroFeed();
    loadTraceLogs();
    loadDecisionHistory(decisionDateFilter, decisionStatusFilter);
    loadPerformance();
    loadComplianceLast30d();
    loadModelLatency();
    loadErrors();
    loadStrategies();
    loadMemories();
  }, [
    loadHeroStatus,
    loadHeroFeed,
    loadTraceLogs,
    loadDecisionHistory,
    loadPerformance,
    loadComplianceLast30d,
    loadModelLatency,
    loadErrors,
    loadStrategies,
    loadMemories,
    decisionDateFilter,
    decisionStatusFilter,
  ]);

  useEffect(() => {
    loadTraceLogs();
  }, [traceDay, loadTraceLogs]);

  useEffect(() => {
    loadDecisionHistory(decisionDateFilter, decisionStatusFilter);
  }, [decisionDateFilter, decisionStatusFilter, loadDecisionHistory]);

  // Real-time + polling fallback
  useEffect(() => {
    const STRATEGY_SUSPENSION_EVENTS = new Set([
      "strategy_suspended_sharpe",
      "strategy_suspended_drawdown",
      "strategy_suspended_hitrate",
      "strategy_resumed",
    ]);
    const ERROR_EVENTS = new Set([
      "risk_check_failed",
      "position_limit_hit",
      "daily_loss_limit_hit",
      "strategy_loss_streak",
      "memory_quarantined",
      "auto_trade_strategy_error",
    ]);

    const channel = supabase
      .channel("obs-realtime-v2")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "compliance_log" },
        (payload) => {
          const ev = payload.new as ComplianceEvent;

          // Hero live ticker
          setHeroFeed((prev) => [ev, ...prev.slice(0, 9)]);
          setNewEventIds((prev) => {
            const next = new Set(prev);
            next.add(ev.id);
            setTimeout(() => setNewEventIds((s) => { const n = new Set(s); n.delete(ev.id); return n; }), 2000);
            return next;
          });

          // Prepend to trace list on new run
          if (ev.event_type === "auto_trade_run") {
            setTraceRuns((prev) => [ev, ...prev.slice(0, 199)]);
            loadHeroStatus();
            loadComplianceLast30d(); // refresh tool counts
          }

          // Refresh errors section on any error/guardrail event
          if (ERROR_EVENTS.has(ev.event_type) || ev.severity === "error" || ev.severity === "critical" || ev.severity === "warning") {
            loadErrors();
          }

          // Refresh strategy health on suspension/resume
          if (STRATEGY_SUSPENSION_EVENTS.has(ev.event_type)) {
            loadStrategies();
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        () => {
          loadHeroStatus();
          loadDecisionHistory("30d", "all");
          loadPerformance();
          loadComplianceLast30d(); // trade count for cost section
        }
      )
      .subscribe();

    // 2-minute polling fallback — catches anything real-time misses
    const poll = setInterval(() => {
      loadHeroStatus();
      loadHeroFeed();
      loadTraceLogs();
      loadDecisionHistory("30d", "all");
      loadPerformance();
      loadComplianceLast30d();
      loadModelLatency();
      loadErrors();
      loadStrategies();
      loadMemories();
    }, 2 * 60 * 1000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, [
    loadHeroStatus,
    loadHeroFeed,
    loadTraceLogs,
    loadDecisionHistory,
    loadPerformance,
    loadComplianceLast30d,
    loadModelLatency,
    loadErrors,
    loadStrategies,
    loadMemories,
  ]);

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

  // Cost stats — auto_trade_strategy_run is exactly 1 LLM qualify call per strategy per run
  const llmCallsLast30d = toolCounts["auto_trade_strategy_run"] ?? 0;
  const dailyLLMSpend =
    llmCallsLast30d > 0
      ? (llmCallsLast30d *
          ((QUALIFY_INPUT_TOKENS / 1_000_000) * LLM_INPUT_PER_M +
            (QUALIFY_OUTPUT_TOKENS / 1_000_000) * LLM_OUTPUT_PER_M)) /
        30
      : 0;
  const avgTokensPerDecision = QUALIFY_INPUT_TOKENS + QUALIFY_OUTPUT_TOKENS;
  const costPerTrade =
    tradesLast30dCount > 0 ? (dailyLLMSpend * 30) / tradesLast30dCount : null;

  // Cost per run
  const autoTradeRunCount = toolCounts["auto_trade_run"] ?? 0;
  const avgStrategiesPerRun = autoTradeRunCount > 0
    ? llmCallsLast30d / autoTradeRunCount
    : 0;
  const costPerRun = avgStrategiesPerRun > 0
    ? avgStrategiesPerRun *
      ((QUALIFY_INPUT_TOKENS / 1_000_000) * LLM_INPUT_PER_M +
       (QUALIFY_OUTPUT_TOKENS / 1_000_000) * LLM_OUTPUT_PER_M)
    : null;

  // Model usage stats (30d)
  const inputTokens30d = llmCallsLast30d * QUALIFY_INPUT_TOKENS;
  const outputTokens30d = llmCallsLast30d * QUALIFY_OUTPUT_TOKENS;
  const totalSpend30d = dailyLLMSpend * 30;
  const cycleLabel = avgCycleMs !== null
    ? avgCycleMs >= 1000 ? `${(avgCycleMs / 1000).toFixed(1)}s` : `${avgCycleMs}ms`
    : null;

  const primaryMode = strategies[0]?.mode ?? "paper";

  const tools = [
    {
      name: "Market Scanner",
      desc: "Scans all open markets for edge opportunities",
      calls: toolCounts["surface_scan_complete"] ?? 0,
      errors: 0,
    },
    {
      name: "Strategy Engine",
      desc: "Evaluates signals per active strategy (1 LLM call each)",
      calls: toolCounts["auto_trade_strategy_run"] ?? 0,
      errors: toolCounts["auto_trade_strategy_error"] ?? 0,
    },
    {
      name: "Order Execution",
      desc: primaryMode === "live" ? "Basket orders submitted to Kalshi" : "Trades placed (paper — basket_completed fires in live mode)",
      calls: tradesLast30dCount,
      errors: toolCounts["basket_aborted"] ?? 0,
    },
    {
      name: "Settlement Engine",
      desc: "Resolves positions after market closes",
      calls: toolCounts["auto_settle_run"] ?? 0,
      errors: 0,
    },
    {
      name: "Memory & Learning",
      desc: "Reflects on trades and updates agent memory",
      calls: toolCounts["auto_reflect_run"] ?? 0,
      errors: 0,
    },
    {
      name: "Risk Guard",
      desc: "Blocks trades that fail pre-flight checks",
      calls: toolCounts["auto_trade_skipped"] ?? 0,
      errors: toolCounts["strategy_auto_halted"] ?? 0,
    },
  ];

  // Memory derived stats
  const activeMemories = memories.filter((m) => m.is_active && !m.quarantined_at);
  const quarantinedMemories = memories.filter((m) => m.quarantined_at);
  const avgConfidence = activeMemories.length > 0
    ? activeMemories.reduce((s, m) => s + m.confidence, 0) / activeMemories.length
    : null;
  const memoryTypeCounts = activeMemories.reduce<Record<string, number>>((acc, m) => {
    acc[m.memory_type] = (acc[m.memory_type] ?? 0) + 1;
    return acc;
  }, {});

  // Confidence histogram buckets for the panel chart
  const confBuckets = [
    { range: "0–0.2", count: memories.filter((m) => m.confidence < 0.2).length },
    { range: "0.2–0.4", count: memories.filter((m) => m.confidence >= 0.2 && m.confidence < 0.4).length },
    { range: "0.4–0.6", count: memories.filter((m) => m.confidence >= 0.4 && m.confidence < 0.6).length },
    { range: "0.6–0.8", count: memories.filter((m) => m.confidence >= 0.6 && m.confidence < 0.8).length },
    { range: "0.8–1.0", count: memories.filter((m) => m.confidence >= 0.8).length },
  ];

  // Filtered + sorted memories for the panel
  const filteredMemories = memories
    .filter((m) => {
      if (memoryTypeFilter === "quarantined") return !!m.quarantined_at;
      if (memoryTypeFilter !== "all") return m.memory_type === memoryTypeFilter;
      return true;
    })
    .sort((a, b) => {
      if (memorySortBy === "confidence") return b.confidence - a.confidence;
      if (memorySortBy === "confirmations") return b.confirmations - a.confirmations;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
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

        {/* ── 2. Performance ───────────────────────────────────────────── */}
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

        {/* ── Agent Memory ────────────────────────────────────────────── */}
        <Section
          title="Agent Memory"
          action={
            <button
              onClick={() => setMemoryPanelOpen(true)}
              className="text-xs text-primary hover:opacity-80 transition-opacity font-medium"
            >
              View All →
            </button>
          }
        >
          <div className="px-6 py-4">
            {memories.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                {isAuthenticated === false ? "Sign in to view agent memory." : "Loading…"}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                {/* Total active */}
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold tabular-nums">{activeMemories.length}</span>
                  <span className="text-xs text-muted-foreground">active</span>
                </div>
                {quarantinedMemories.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold tabular-nums text-red-500">{quarantinedMemories.length}</span>
                    <span className="text-xs text-muted-foreground">quarantined</span>
                  </div>
                )}
                {avgConfidence !== null && (
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold tabular-nums">{(avgConfidence * 100).toFixed(0)}%</span>
                    <span className="text-xs text-muted-foreground">avg confidence</span>
                  </div>
                )}
                {/* Type pills */}
                <div className="flex flex-wrap gap-1.5 ml-2">
                  {Object.entries(memoryTypeCounts).map(([type, count]) => (
                    <button
                      key={type}
                      onClick={() => { setMemoryTypeFilter(type); setMemoryPanelOpen(true); }}
                      className={`text-[10px] font-medium px-2 py-0.5 rounded-full transition-colors hover:opacity-80 ${MEMORY_TYPE_COLORS[type] ?? "bg-secondary text-muted-foreground"}`}
                    >
                      {MEMORY_TYPE_LABELS[type] ?? type} {count}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ── 5. Cost & Efficiency ─────────────────────────────────────── */}
        <Section title="Cost & Efficiency">
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-4 gap-4">
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
                  {tradesLast30dCount} trades last 30d
                </p>
              </div>
              <div className="rounded-xl border border-border p-4">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
                  Cost / Run
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {costPerRun !== null
                    ? costPerRun < 0.000001
                      ? "<$0.000001"
                      : `$${costPerRun.toFixed(6)}`
                    : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {autoTradeRunCount > 0 ? `${avgStrategiesPerRun.toFixed(1)} strat/run avg` : "no run data"}
                </p>
              </div>
            </div>

            {/* Model usage */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Model
                </p>
                <span className="text-[10px] font-medium bg-secondary px-2 py-0.5 rounded-full">
                  gpt-4o-mini · OpenRouter
                </span>
              </div>
              <div className="grid grid-cols-5 gap-3">
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Calls (30d)</p>
                  <p className="text-base font-bold tabular-nums">{llmCallsLast30d.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">strategy evaluations</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Input tokens</p>
                  <p className="text-base font-bold tabular-nums">
                    {inputTokens30d >= 1_000_000
                      ? `${(inputTokens30d / 1_000_000).toFixed(2)}M`
                      : `${(inputTokens30d / 1_000).toFixed(0)}K`}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{QUALIFY_INPUT_TOKENS.toLocaleString()} / call</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Output tokens</p>
                  <p className="text-base font-bold tabular-nums">
                    {outputTokens30d >= 1_000_000
                      ? `${(outputTokens30d / 1_000_000).toFixed(2)}M`
                      : `${(outputTokens30d / 1_000).toFixed(0)}K`}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{QUALIFY_OUTPUT_TOKENS} / call</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Spend (30d)</p>
                  <p className="text-base font-bold tabular-nums">${totalSpend30d.toFixed(4)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    ${(LLM_INPUT_PER_M / 1000).toFixed(3)}/1K in
                  </p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Avg cycle</p>
                  <p className="text-base font-bold tabular-nums">
                    {cycleLabel ?? <span className="text-muted-foreground">—</span>}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">run → last event</p>
                </div>
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
                      <tr
                        key={ev.id}
                        onClick={() => setSelectedError(ev)}
                        className="hover:bg-secondary/20 transition-colors cursor-pointer"
                      >
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
                Warnings &amp; Errors
              </p>
              {errorEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No warnings or errors in the log.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-border">
                    {errorEvents.map((ev) => (
                      <tr
                        key={ev.id}
                        onClick={() => setSelectedError(ev)}
                        className="hover:bg-secondary/20 transition-colors cursor-pointer"
                      >
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

        {/* ── 5. Trace Logs ────────────────────────────────────────────── */}
        <Section
          title="Execution Traces"
          action={
            <div className="flex items-center gap-3">
              {/* Day tabs */}
              <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                {[0, 1, 2, 3].map((daysAgo) => {
                  const d = new Date();
                  d.setDate(d.getDate() - daysAgo);
                  const iso = d.toISOString().slice(0, 10);
                  const label = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo}d ago`;
                  return (
                    <button
                      key={iso}
                      onClick={() => setTraceDay(iso)}
                      className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium ${
                        traceDay === iso
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {/* Custom date */}
              <input
                type="date"
                value={traceDay}
                onChange={(e) => setTraceDay(e.target.value)}
                className="text-[10px] bg-secondary border border-border rounded-lg px-2 py-1 text-muted-foreground"
              />
              {/* Langfuse link */}
              <a
                href="https://cloud.langfuse.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
              >
                Langfuse
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
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

        {/* ── 6. Decision History ──────────────────────────────────────── */}
        <Section
          title="Decision History"
          action={
            <div className="flex items-center gap-2">
              {/* Date filter */}
              <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                {(["today", "7d", "30d", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setDecisionDateFilter(f)}
                    className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                      decisionDateFilter === f
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              {/* Status filter */}
              <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                {(["all", "filled", "settled"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setDecisionStatusFilter(f)}
                    className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                      decisionStatusFilter === f
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          }
        >
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
                        onClick={() => setSelectedTrade(t)}
                        className="hover:bg-secondary/30 transition-colors cursor-pointer"
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

    {/* ── Agent Memory Panel ──────────────────────────────────────── */}
    {memoryPanelOpen && (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          onClick={() => setMemoryPanelOpen(false)}
        />
        {/* Panel */}
        <div className="fixed right-0 top-0 h-full w-full max-w-[640px] z-50 bg-card border-l border-border flex flex-col overflow-hidden">
          {/* Panel header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-sm font-semibold">Agent Memory</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {activeMemories.length} active · {quarantinedMemories.length} quarantined · {memories.length} total
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://supabase.com/dashboard/project/uyfnezxmgwitpzsrnkst/editor"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
              >
                Open in Supabase
                <ExternalLink className="h-3 w-3" />
              </a>
              <button
                onClick={() => setMemoryPanelOpen(false)}
                className="text-muted-foreground hover:text-foreground transition-colors text-xl leading-none"
              >
                ×
              </button>
            </div>
          </div>

          {/* Confidence histogram */}
          {confBuckets.some((b) => b.count > 0) && (
            <div className="px-6 pt-4 pb-2 shrink-0">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Confidence Distribution</p>
              <ResponsiveContainer width="100%" height={60}>
                <BarChart data={confBuckets} barSize={24}>
                  <XAxis dataKey="range" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v: number) => [v, "memories"]} contentStyle={{ fontSize: 10, borderRadius: 6 }} />
                  <Bar dataKey="count" fill="hsl(var(--primary))" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Filter + sort bar */}
          <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-wrap shrink-0">
            <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5 flex-wrap">
              {(["all", "lesson", "pattern", "mistake", "success", "market_note", "quarantined"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setMemoryTypeFilter(f)}
                  className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                    memoryTypeFilter === f
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f === "market_note" ? "Market Note" : f}
                </button>
              ))}
            </div>
            <select
              value={memorySortBy}
              onChange={(e) => setMemorySortBy(e.target.value as "confidence" | "confirmations" | "newest")}
              className="text-[10px] bg-secondary border border-border rounded-lg px-2 py-1 text-muted-foreground ml-auto"
            >
              <option value="confidence">Sort: Confidence</option>
              <option value="confirmations">Sort: Confirmations</option>
              <option value="newest">Sort: Newest</option>
            </select>
          </div>

          {/* Memory list */}
          <div className="flex-1 overflow-y-auto divide-y divide-border">
            {filteredMemories.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">No memories match this filter.</div>
            ) : (
              filteredMemories.map((mem) => {
                const isExpanded = expandedMemoryId === mem.id;
                const conf = mem.confidence;
                return (
                  <div key={mem.id} className="px-6 py-4">
                    {/* Top row */}
                    <div className="flex items-start gap-2 mb-2">
                      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${MEMORY_TYPE_COLORS[mem.memory_type] ?? "bg-secondary text-muted-foreground"}`}>
                        {MEMORY_TYPE_LABELS[mem.memory_type] ?? mem.memory_type}
                      </span>
                      {mem.quarantined_at && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500">quarantined</span>
                      )}
                      <span className="text-[11px] text-muted-foreground ml-auto shrink-0 tabular-nums">
                        {mem.confirmations}✓ {mem.contradictions}✗
                      </span>
                    </div>
                    {/* Title + confidence */}
                    <button
                      onClick={() => setExpandedMemoryId(isExpanded ? null : mem.id)}
                      className="w-full text-left"
                    >
                      <p className="text-[13px] font-medium leading-snug mb-1.5">{mem.title}</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${conf * 100}%`,
                              backgroundColor: conf >= 0.6 ? "hsl(var(--primary))" : conf >= 0.4 ? "#eab308" : "#ef4444",
                            }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                          {(conf * 100).toFixed(0)}%
                        </span>
                      </div>
                    </button>
                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="mt-3 space-y-2">
                        <div className="rounded-lg bg-secondary/40 p-3">
                          <p className="text-[12px] text-foreground leading-relaxed whitespace-pre-wrap">{mem.content}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                          {mem.scope && <span>scope: {mem.scope}</span>}
                          {mem.trade_sample_size > 0 && <span>sample: {mem.trade_sample_size} trades</span>}
                          {mem.last_recalled_at && <span>recalled: {relativeTime(mem.last_recalled_at)}</span>}
                          <span>created: {fmtDate(mem.created_at)}</span>
                        </div>
                        {mem.tags && mem.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {mem.tags.map((tag) => (
                              <span key={tag} className="text-[10px] bg-secondary px-1.5 py-0.5 rounded-full">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </>
    )}

    {/* ── Trade Detail Panel ───────────────────────────────────────── */}

    {selectedTrade && (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        onClick={() => setSelectedTrade(null)}
      >
        <div
          className="bg-card rounded-2xl apple-shadow w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-1">
                {selectedTrade.strategy ?? "Manual"} · {fmtDate(selectedTrade.created_at)}
              </p>
              <h3 className="text-sm font-semibold leading-snug">
                {selectedTrade.market_question ?? selectedTrade.ticker ?? "Trade Detail"}
              </h3>
            </div>
            <button
              onClick={() => setSelectedTrade(null)}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-lg leading-none mt-0.5"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-5">
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              {[
                {
                  label: "Action",
                  value: `${selectedTrade.action?.toUpperCase()} ${selectedTrade.side?.toUpperCase()}`,
                  cls: selectedTrade.action === "buy" || selectedTrade.side === "yes" ? "text-emerald-500" : "text-red-500",
                },
                { label: "Entry Price", value: `${selectedTrade.filled_price ?? selectedTrade.price}¢`, cls: "" },
                { label: "Size", value: `$${selectedTrade.amount?.toFixed(2) ?? "—"}`, cls: "" },
              ].map(({ label, value, cls }) => (
                <div key={label} className="rounded-xl bg-secondary/40 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
                  <p className={`text-sm font-semibold tabular-nums ${cls || "text-foreground"}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* P&L + Status */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-secondary/40 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">P&L</p>
                {selectedTrade.pnl !== null ? (
                  <p className={`text-lg font-bold tabular-nums ${selectedTrade.pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    {selectedTrade.pnl >= 0 ? "+" : ""}${selectedTrade.pnl.toFixed(2)}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Pending</p>
                )}
              </div>
              <div className="rounded-xl bg-secondary/40 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Status</p>
                <p className="text-sm font-semibold capitalize">{selectedTrade.status}</p>
                {selectedTrade.settled_at && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Settled {fmtDate(selectedTrade.settled_at)}
                  </p>
                )}
              </div>
            </div>

            {/* Duration */}
            {selectedTrade.settled_at && (
              <div className="rounded-xl bg-secondary/40 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Hold Duration</p>
                <p className="text-sm font-medium text-foreground">
                  {(() => {
                    const ms = new Date(selectedTrade.settled_at).getTime() - new Date(selectedTrade.created_at).getTime();
                    const h = Math.floor(ms / 3600000);
                    const m = Math.floor((ms % 3600000) / 60000);
                    return h > 0 ? `${h}h ${m}m` : `${m}m`;
                  })()}
                </p>
              </div>
            )}

            {/* Agent Reasoning */}
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Agent Reasoning</p>
              {selectedTrade.notes ? (
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-foreground leading-relaxed whitespace-pre-wrap">
                    {selectedTrade.notes}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-muted-foreground italic">
                    No reasoning captured for this trade. LLM trace available in{" "}
                    <a href="https://cloud.langfuse.com" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                      Langfuse ↗
                    </a>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ── Error Detail Panel ───────────────────────────────────────── */}
    {selectedError && (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        onClick={() => setSelectedError(null)}
      >
        <div
          className="bg-card rounded-2xl apple-shadow w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                  selectedError.severity === "critical" || selectedError.severity === "error"
                    ? "bg-red-500/10 text-red-500"
                    : selectedError.severity === "warning"
                    ? "bg-yellow-500/10 text-yellow-500"
                    : "bg-secondary text-muted-foreground"
                }`}>
                  {selectedError.severity}
                </span>
                <span className="text-xs text-muted-foreground">{fmtDate(selectedError.created_at)}</span>
              </div>
              <h3 className="text-sm font-semibold">
                {EVENT_TYPE_LABELS[selectedError.event_type] ?? selectedError.event_type}
              </h3>
            </div>
            <button
              onClick={() => setSelectedError(null)}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-lg leading-none mt-0.5"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-4">
            {/* Raw message */}
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Event Message</p>
              <div className="rounded-xl bg-secondary/40 p-4">
                <p className="text-[12px] text-foreground leading-relaxed font-mono">
                  {selectedError.message}
                </p>
              </div>
            </div>

            {/* Summary */}
            {ERROR_SUMMARIES[selectedError.event_type] && (
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">What Happened</p>
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-foreground leading-relaxed">
                    {ERROR_SUMMARIES[selectedError.event_type]}
                  </p>
                </div>
              </div>
            )}

            {/* Resolution */}
            {ERROR_RESOLUTIONS[selectedError.event_type] ? (
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Possible Resolution</p>
                <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-4">
                  <p className="text-[12px] text-foreground leading-relaxed">
                    {ERROR_RESOLUTIONS[selectedError.event_type]}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Next Steps</p>
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    Check the{" "}
                    <a href="https://cloud.langfuse.com" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                      Langfuse traces ↗
                    </a>{" "}
                    or Supabase Edge Function logs for more detail.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    </>
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
