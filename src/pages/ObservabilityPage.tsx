import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Token counts (estimated from qualify prompt structure) ────────────────────
// Input: system rules (~300) + market context (~600) + memory lessons (~300) = ~1200
// Output: "QUALIFY/REJECT\nReason: [one sentence]" — actual avg ~25 tokens; max_tokens=100
// Note: auto-qualify bypass (edge >= 25¢) skips the LLM — these counts include all strategy
// runs, so LLM call count is an upper bound (actual calls = runs - auto-qualified).
const QUALIFY_INPUT_TOKENS = 1_200;
const QUALIFY_OUTPUT_TOKENS = 25; // corrected from 50 — actual response is ~1 word + 1 sentence

// ── Model cost lookup (per million tokens) ────────────────────────────────────
// Key = model identifier as stored in api_keys.key_id / as sent to OpenRouter
interface ModelInfo { label: string; provider: string; input: number; output: number }
const MODEL_COSTS: Record<string, ModelInfo> = {
  // OpenRouter-routed models (prefix "openai/" etc)
  "openai/gpt-4o-mini":                  { label: "gpt-4o-mini",          provider: "OpenRouter", input: 0.15,  output: 0.60  },
  "openai/gpt-4o":                        { label: "gpt-4o",               provider: "OpenRouter", input: 2.50,  output: 10.00 },
  "openai/gpt-4-turbo":                   { label: "gpt-4-turbo",          provider: "OpenRouter", input: 10.00, output: 30.00 },
  "anthropic/claude-3-5-haiku":           { label: "claude-3.5-haiku",     provider: "OpenRouter", input: 0.80,  output: 4.00  },
  "anthropic/claude-3-5-haiku-20241022":  { label: "claude-3.5-haiku",     provider: "OpenRouter", input: 0.80,  output: 4.00  },
  "anthropic/claude-3-5-sonnet":          { label: "claude-3.5-sonnet",    provider: "OpenRouter", input: 3.00,  output: 15.00 },
  "anthropic/claude-3-5-sonnet-20241022": { label: "claude-3.5-sonnet",    provider: "OpenRouter", input: 3.00,  output: 15.00 },
  "anthropic/claude-sonnet-4-6":          { label: "claude-sonnet-4.6",    provider: "OpenRouter", input: 3.00,  output: 15.00 },
  "anthropic/claude-opus-4-7":            { label: "claude-opus-4.7",      provider: "OpenRouter", input: 15.00, output: 75.00 },
  "anthropic/claude-haiku-4-5":           { label: "claude-haiku-4.5",     provider: "OpenRouter", input: 0.80,  output: 4.00  },
  "google/gemini-flash-1.5":              { label: "gemini-1.5-flash",     provider: "OpenRouter", input: 0.075, output: 0.30  },
  "google/gemini-pro-1.5":                { label: "gemini-1.5-pro",       provider: "OpenRouter", input: 1.25,  output: 5.00  },
  "google/gemini-2.0-flash":              { label: "gemini-2.0-flash",     provider: "OpenRouter", input: 0.10,  output: 0.40  },
  // Direct Anthropic (no prefix)
  "claude-3-5-haiku-20241022":            { label: "claude-3.5-haiku",     provider: "Anthropic",  input: 0.80,  output: 4.00  },
  "claude-3-5-sonnet-20241022":           { label: "claude-3.5-sonnet",    provider: "Anthropic",  input: 3.00,  output: 15.00 },
  "claude-sonnet-4-6":                    { label: "claude-sonnet-4.6",    provider: "Anthropic",  input: 3.00,  output: 15.00 },
  "claude-opus-4-7":                      { label: "claude-opus-4.7",      provider: "Anthropic",  input: 15.00, output: 75.00 },
  "claude-haiku-4-5":                     { label: "claude-haiku-4.5",     provider: "Anthropic",  input: 0.80,  output: 4.00  },
  // Direct OpenAI (no prefix)
  "gpt-4o-mini":                          { label: "gpt-4o-mini",          provider: "OpenAI",     input: 0.15,  output: 0.60  },
  "gpt-4o":                               { label: "gpt-4o",               provider: "OpenAI",     input: 2.50,  output: 10.00 },
};
const DEFAULT_MODEL_INFO: ModelInfo = { label: "gpt-4o-mini", provider: "OpenRouter", input: 0.15, output: 0.60 };

// ── Failure Mode Details ───────────────────────────────────────────────────────

const FAILURE_MODE_DETAILS: Record<string, { title: string; description: string; resolution: string }> = {
  llm_timeout: {
    title: "LLM API Timeout",
    description: "The qualify call to OpenRouter/Anthropic exceeded 15 seconds and was aborted. The strategy is skipped for this run — market opportunity missed, no trade blocked.",
    resolution: "Check OpenRouter status (status.openrouter.ai). If sustained, increase QUALIFY_TIMEOUT_MS in the edge function or switch to a faster model (gpt-4o-mini is fastest).",
  },
  kalshi_timeout: {
    title: "Kalshi API Timeout",
    description: "A request to the Kalshi REST API timed out — market data fetch or order submission. The surface scanner or order executor aborted the call.",
    resolution: "Check Kalshi status. Kalshi maintenance windows happen weekly. If orders are timing out, reduce basket size or add retry logic in execute-basket.",
  },
  llm_rate_limit: {
    title: "LLM Rate Limits",
    description: "OpenRouter returned a 429 Too Many Requests. The qualify call failed and the strategy was skipped. Repeated rate limits mean the account RPM/TPM limit is too low for the current cron frequency.",
    resolution: "Check your OpenRouter dashboard for current usage vs. plan limits. Upgrade the rate limit tier or increase the cron interval from 2min to 5min in the pg_cron schedule.",
  },
  kalshi_rate_limit: {
    title: "Kalshi Rate Limits",
    description: "Kalshi REST API returned 429 Too Many Requests on a market data fetch or order submission. Kalshi enforces per-minute and per-second request limits. The surface scanner batches multiple series requests in a single run — if too many users are running simultaneously, the shared IP pool may hit the limit.",
    resolution: "Kalshi's rate limit is typically 10 req/s or 600 req/min. Add exponential backoff + retry logic to the surface scanner's market fetch loop. If multi-tenant traffic is the cause, stagger cron schedules per user (offset by user_id hash). Check the Kalshi developer portal for current limits.",
  },
  cost_spike: {
    title: "Cost Spike",
    description: "LLM call rate in the last 6 hours is significantly above the 30-day hourly average. Could indicate a misconfigured cron schedule, a runaway retry loop, or an unusually active market session driving many concurrent signals.",
    resolution: "Review execution traces to check if auto_trade_strategy_run frequency is abnormal. Verify the pg_cron schedule in Supabase. If it's legitimate market activity, no action needed.",
  },
  exchange_error: {
    title: "Exchange Data Errors",
    description: "Kalshi API returned malformed or schema-mismatched market data. Usually caused by Kalshi maintenance windows or API field changes.",
    resolution: "Check Kalshi API changelog. These are usually transient. If sustained, a market field may have been renamed — compare error against current Kalshi API spec.",
  },
  strategy_error: {
    title: "Strategy Code Errors",
    description: "A strategy threw an unhandled exception — null/undefined field access, JSON parse failure, or schema mismatch in the qualify prompt.",
    resolution: "Check the specific error message below. Common cause: strategy accessing a market field that can be null (closeTime, yes_ask, no_bid). Add null guards.",
  },
  pii_detected: {
    title: "PII Detected",
    description: "A compliance log message appears to contain personal identifiable information (email address or phone number pattern). This should never appear in operational logs and represents a data handling violation.",
    resolution: "Identify the event and trace its source. Remove or sanitize the PII from any log store. Review the code path that produced the event and add input sanitization before logging.",
  },
  db_connection: {
    title: "DB / Connection Errors",
    description: "Supabase client returned a connection error, socket failure, or database-level error. Edge functions depend on the DB for trade state, risk rules, and memory injection — connection failures degrade all operations.",
    resolution: "Check Supabase project status and connection pooler health. If persistent, review edge function database connection limits. Supabase free tier pauses after 7 days of inactivity.",
  },
  network_failure: {
    title: "Network Failures",
    description: "Outbound network requests from edge functions failed at the transport layer — DNS resolution failure, connection refused, or unreachable host. Distinct from API errors (4xx/5xx) which indicate the host was reached.",
    resolution: "Check Deno Deploy / Supabase Edge Function network status. These are usually transient. If sustained, verify the target API domain hasn't changed and that no IP allowlisting is required.",
  },
  memory_pressure: {
    title: "Memory",
    description: "A significant portion of agent memories have been quarantined (exposed confidence below 0.30 after 10+ attributed trades). High quarantine count means the agent accumulated lessons that real trade outcomes later contradicted.",
    resolution: "Review quarantined memories in the Agent Memory panel — look for patterns in which strategies or market conditions produced bad lessons. Run compact-memory to compress and merge the active memory graph (token savings). Quarantined entries can only be cleared by resetting their is_active flag directly in the DB.",
  },
  execution_gap: {
    title: "Execution Gaps",
    description: "A gap of more than 5 minutes was detected between consecutive auto_trade_run or auto_trade_skipped events. The cron fires every 30 seconds — gaps longer than 5 minutes indicate the edge function crashed or timed out mid-execution without logging a completion event.",
    resolution: "Check Supabase Edge Function logs for the gap window. Common causes: edge function timeout (functions have a 60s limit by default), stale lock that wasn't released on crash (LOCK_STALE_MS=5min), or a transient Supabase cold-start. If gaps recur, add a try/finally block to the auto-trade function to guarantee the lock is released even on error.",
  },
};

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
  filled_at: string | null;
  settled_at: string | null;
}

interface Strategy {
  id: string;
  name: string;
  active: boolean;
  mode: string;
  suspended_until: string | null;
  suspension_reason: string | null;
  starting_balance: number | null;
  user_id: string | null;
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
  if (minsAgo < 8)
    return {
      label: "Running",
      color: "text-emerald-500",
      dot: "bg-emerald-500",
    };
  if (minsAgo < 240)
    return { label: "Healthy", color: "text-emerald-400", dot: "bg-emerald-400" };
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
  const [userId, setUserId] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null); // stable ref for realtime/poll closures
  const viewUserIdRef = useRef<string | null>(null); // tracks viewUserId for RT/poll closures
  const [isAdmin, setIsAdmin] = useState(false);
  const [viewUserId, setViewUserId] = useState<string | null>(null); // null = platform view
  const [userList, setUserList] = useState<{ id: string; strategyCount: number }[]>([]);

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
  // Real token usage from llm_usage compliance_log events (actual API response counts)
  const [realTokenStats, setRealTokenStats] = useState<{
    calls: number;
    avgInputTokens: number | null;
    avgOutputTokens: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
  } | null>(null);

  const [stratRunDurations, setStratRunDurations] = useState<{ ts: number; seconds: number }[]>([]);

  // 24h activity — dedicated server-side counts (not derived from capped array)
  const [runs24hCount, setRuns24hCount] = useState<number | null>(null);
  const [stratRuns24hCount, setStratRuns24hCount] = useState<number | null>(null);
  const [runs6hCount, setRuns6hCount] = useState<number | null>(null);
  const [scans24hCount, setScans24hCount] = useState<number | null>(null);
  const [tradesFilled24hCount, setTradesFilled24hCount] = useState<number | null>(null);
  // 24h error events — for failure mode detection (error/warning only, last 24h, last 500)
  const [errors24h, setErrors24h] = useState<ComplianceEvent[]>([]);
  // Dedicated rate limit counts — catches events logged at any severity
  const [rateLimitCount24h, setRateLimitCount24h] = useState<number | null>(null);
  const [kalshiRateLimitCount24h, setKalshiRateLimitCount24h] = useState<number | null>(null);
  // Surface scan durations for market data pull latency
  const [scanDurations, setScanDurations] = useState<number[]>([]);
  // Execution gap detection — gaps > 5 min between auto_trade_run/skipped events
  const [gapEvents, setGapEvents] = useState<{ from: string; to: string; gapMins: number }[]>([]);

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
  const [selectedFailureMode, setSelectedFailureMode] = useState<string | null>(null);
  const [clearingMemory, setClearingMemory] = useState(false);
  const [selectedTimelineHour, setSelectedTimelineHour] = useState<{ label: string; events: ComplianceEvent[] } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [traceExpanded, setTraceExpanded] = useState(false);
  const [tracePage, setTracePage] = useState(1);
  const [activeModel, setActiveModel] = useState<string | null>(null);

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

  const loadHeroStatus = useCallback(async (uid?: string | null) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let complianceQ = supabase
      .from("compliance_log")
      .select("created_at")
      .in("event_type", ["auto_trade_run", "auto_trade_skipped"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let openQ = supabase
      .from("trades")
      .select("amount")
      .eq("status", "filled")
      .is("settled_at", null);
    let pnlQ = supabase
      .from("trades")
      .select("pnl")
      .eq("status", "settled")
      .gte("settled_at", todayStart.toISOString());

    if (uid) {
      openQ = openQ.eq("user_id", uid);
      pnlQ = pnlQ.eq("user_id", uid);
    }

    const [lastRunRes, openRes, pnlRes] = await Promise.all([complianceQ, openQ, pnlQ]);

    setLastRunAt(lastRunRes.data?.created_at ?? null);

    const openTrades: { amount: number }[] = openRes.data ?? [];
    setOpenPositionCount(openTrades.length);
    setOpenPositionValue(openTrades.reduce((s, t) => s + (t.amount ?? 0), 0));

    const pnlTrades: { pnl: number | null }[] = pnlRes.data ?? [];
    setTodayPnl(pnlTrades.reduce((s, t) => s + (t.pnl ?? 0), 0));
  }, []);

  const loadHeroFeed = useCallback(async (uid?: string | null) => {
    let q = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .order("created_at", { ascending: false })
      .limit(10);
    if (uid) q = q.eq("user_id", uid);
    const { data } = await q;
    if (data) setHeroFeed(data as ComplianceEvent[]);
  }, []);

  const loadTraceLogs = useCallback(async (uid?: string | null) => {
    const dayStart = new Date(traceDay + "T00:00:00.000Z").toISOString();
    const dayEnd   = new Date(traceDay + "T23:59:59.999Z").toISOString();
    let q = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .eq("event_type", "auto_trade_run")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: false })
      .limit(200);
    if (uid) q = q.eq("user_id", uid);
    const { data } = await q;
    if (data) setTraceRuns(data as ComplianceEvent[]);
  }, [traceDay]);

  const loadDecisionHistory = useCallback(async (
    dateFilter: "today" | "7d" | "30d" | "all" = "30d",
    statusFilter: "all" | "filled" | "settled" = "all",
    uid?: string | null
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

    if (uid) query = query.eq("user_id", uid);

    const { data } = await query;
    if (data) setDecisionTrades(data as Trade[]);
  }, []);

  const loadPerformance = useCallback(async (uid?: string | null) => {
    let q = supabase
      .from("trades")
      .select("id, pnl, created_at, filled_at, settled_at, status, strategy_id")
      .eq("status", "settled")
      .gte("settled_at", "2026-04-22T00:00:00.000Z")
      .order("settled_at", { ascending: true });
    if (uid) q = q.eq("user_id", uid);
    const { data } = await q;
    if (data) {
      setAllSettledTrades(data as Trade[]);
      // Build equity curve — one point per day (aggregate trades settled on same day)
      const dailyPnl = new Map<string, number>();
      for (const t of (data as Trade[])) {
        if (!t.settled_at) continue;
        const day = t.settled_at.slice(0, 10); // YYYY-MM-DD key for stable sort
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + (t.pnl ?? 0));
      }
      let cum = 0;
      const pts: EquityPoint[] = Array.from(dailyPnl.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, pnl]) => {
          cum += pnl;
          return { date: fmtShortDate(day + "T12:00:00Z"), cumPnl: parseFloat(cum.toFixed(2)) };
        });
      setEquityData(pts);
    }
  }, []);

  const loadComplianceLast30d = useCallback(async (uid?: string | null) => {
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

    let eventsQ = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    let tradesQ = supabase
      .from("trades")
      .select("*", { count: "exact", head: true })
      .gte("created_at", since);
    // All compliance_log tool events are system-level (user_id = NULL); only trades are per-user.
    if (uid) tradesQ = tradesQ.eq("user_id", uid);

    const toolCountQueries = toolEventTypes.map((et) => {
      return supabase
        .from("compliance_log")
        .select("*", { count: "exact", head: true })
        .eq("event_type", et)
        .gte("created_at", since);
    });

    const [eventsRes, tradesCountRes, ...countResults] = await Promise.all([
      eventsQ,
      tradesQ,
      ...toolCountQueries,
    ]);

    if (eventsRes.data) setComplianceLast30d(eventsRes.data as ComplianceEvent[]);
    setTradesLast30dCount(tradesCountRes.count ?? 0);

    const counts: Record<string, number> = {};
    toolEventTypes.forEach((et, i) => {
      counts[et] = countResults[i].count ?? 0;
    });
    setToolCounts(counts);
  }, []);

  const loadModelLatency = useCallback(async (uid?: string | null) => {
    // Fetch last 8 auto_trade_run events
    let runsQ = supabase
      .from("compliance_log")
      .select("id, created_at")
      .eq("event_type", "auto_trade_run")
      .order("created_at", { ascending: false })
      .limit(8);
    // auto_trade_run is system-level (user_id = NULL) — no uid filter
    const { data: runs } = await runsQ;
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

  const loadActivity24h = useCallback(async (uid?: string | null) => {
    const since24h = new Date(Date.now() - 86_400_000).toISOString();
    const since6h  = new Date(Date.now() - 21_600_000).toISOString();

    let runsQ = supabase.from("compliance_log").select("*", { count: "exact", head: true })
      .eq("event_type", "auto_trade_run").gte("created_at", since24h);
    let stratRuns24hQ = supabase.from("compliance_log").select("*", { count: "exact", head: true })
      .eq("event_type", "auto_trade_strategy_run").gte("created_at", since24h);
    let stratRuns6hQ = supabase.from("compliance_log").select("*", { count: "exact", head: true })
      .eq("event_type", "auto_trade_strategy_run").gte("created_at", since6h);
    let scansQ = supabase.from("compliance_log").select("*", { count: "exact", head: true })
      .eq("event_type", "surface_scan_complete").gte("created_at", since24h);
    let tradesQ = supabase.from("trades").select("*", { count: "exact", head: true })
      .gte("created_at", since24h);

    // Cron events (auto_trade_run, auto_trade_strategy_run, surface_scan_complete) are
    // system-level with user_id = NULL — never filter them by uid.
    // Only trades are per-user.
    if (uid) tradesQ = tradesQ.eq("user_id", uid);

    // stratRuns24hRes and runs6hRes use the same event type — spike ratio is apples-to-apples
    const [runsRes, stratRuns24hRes, stratRuns6hRes, scansRes, tradesRes] = await Promise.all([
      runsQ, stratRuns24hQ, stratRuns6hQ, scansQ, tradesQ,
    ]);
    setRuns24hCount(runsRes.count ?? 0);
    setStratRuns24hCount(stratRuns24hRes.count ?? 0);
    setRuns6hCount(stratRuns6hRes.count ?? 0);
    setScans24hCount(scansRes.count ?? 0);
    setTradesFilled24hCount(tradesRes.count ?? 0);
  }, []);

  const loadErrors24h = useCallback(async (uid?: string | null) => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    let q = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .gte("created_at", since)
      .in("severity", ["error", "warning", "critical"])
      .order("created_at", { ascending: false })
      .limit(500);
    // Dedicated LLM rate limit count — LLM-specific 429s only
    let rlQ = supabase
      .from("compliance_log")
      .select("*", { count: "exact", head: true })
      .gte("created_at", since)
      .or("event_type.eq.llm_rate_limit,message.ilike.%openrouter%429%,message.ilike.%openrouter%rate%limit%,message.ilike.%llm%rate%limit%");
    // Kalshi rate limit: 1h window for status (only red if currently failing),
    // 24h events still captured in errors24h for timeline display.
    const since1h = new Date(Date.now() - 3_600_000).toISOString();
    let krlQ = supabase
      .from("compliance_log")
      .select("*", { count: "exact", head: true })
      .gte("created_at", since1h)
      .or("event_type.eq.kalshi_rate_limit,event_type.eq.kalshi_circuit_open,message.ilike.%kalshi%429%,message.ilike.%kalshi%rate%limit%,message.ilike.%kalshi%too%many%");
    // Include both user-specific errors (user_id = uid) and system-level errors (user_id = NULL)
    if (uid) {
      q = q.or(`user_id.eq.${uid},user_id.is.null`);
      rlQ = rlQ.or(`user_id.eq.${uid},user_id.is.null`);
      krlQ = krlQ.or(`user_id.eq.${uid},user_id.is.null`);
    }
    const [{ data }, { count: rlCount }, { count: krlCount }] = await Promise.all([q, rlQ, krlQ]);
    if (data) setErrors24h(data as ComplianceEvent[]);
    setRateLimitCount24h(rlCount ?? 0);
    setKalshiRateLimitCount24h(krlCount ?? 0);
  }, []);

  const loadErrors = useCallback(async (uid?: string | null) => {
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

    let guardrailQ = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .in("event_type", guardrailTypes)
      .order("created_at", { ascending: false })
      .limit(50);
    // Exclude operational event types that use 'warning' severity for normal outcomes
  // (e.g. surface_scan_complete warns when it finds alerts — that's expected behavior, not an error)
  const operationalEventTypes = [
    "surface_scan_complete",
    "health_check_run",
    "auto_trade_run",
    "auto_trade_strategy_run",
    "auto_trade_skipped",
    "auto_settle_run",
    "auto_reflect_run",
  ];
  let errorQ = supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .in("severity", ["error", "critical", "warning"])
      .not("event_type", "in", `(${operationalEventTypes.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(30);
    // Include both user-specific events (user_id = uid) and system-level events (user_id = NULL)
    if (uid) {
      guardrailQ = guardrailQ.or(`user_id.eq.${uid},user_id.is.null`);
      errorQ = errorQ.or(`user_id.eq.${uid},user_id.is.null`);
    }

    const [guardrailRes, errorRes] = await Promise.all([guardrailQ, errorQ]);

    if (guardrailRes.data) setGuardrailEvents(guardrailRes.data as ComplianceEvent[]);
    if (errorRes.data) setErrorEvents(errorRes.data as ComplianceEvent[]);
  }, []);

  const loadStrategies = useCallback(async (uid?: string | null) => {
    let q = supabase
      .from("strategies")
      .select("id, name, active, mode, suspended_until, suspension_reason, starting_balance, user_id");
    if (uid) q = q.eq("user_id", uid);
    const { data } = await q;
    if (data) setStrategies(data as Strategy[]);
  }, []);

  const loadMemories = useCallback(async (uid?: string | null) => {
    let q = (supabase.from("agent_memory" as any) as any)
      .select("*")
      .order("confidence", { ascending: false })
      .limit(200);
    if (uid) q = q.eq("user_id", uid);
    const { data } = await q;
    if (data) setMemories(data as MemoryEntry[]);
  }, []);

  const loadUserList = useCallback(async () => {
    const { data } = await supabase
      .from("strategies")
      .select("user_id")
      .not("user_id", "is", null);
    if (!data) return;
    const counts = new Map<string, number>();
    (data as { user_id: string }[]).forEach(({ user_id }) =>
      counts.set(user_id, (counts.get(user_id) ?? 0) + 1)
    );
    setUserList(
      Array.from(counts.entries()).map(([id, strategyCount]) => ({ id, strategyCount }))
    );
  }, []);

  const loadActiveModel = useCallback(async () => {
    const { data } = await supabase
      .from("api_keys")
      .select("key_id")
      .eq("provider", "model_agent")
      .maybeSingle();
    if (data?.key_id) setActiveModel(data.key_id as string);
  }, []);

  const loadRealTokenStats = useCallback(async () => {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // llm_usage events are system-level (user_id = NULL) — no uid filter
    const { data } = await supabase
      .from("compliance_log")
      .select("metadata")
      .eq("event_type", "llm_usage")
      .gte("created_at", since30d)
      .limit(10000);
    if (!data || data.length === 0) { setRealTokenStats(null); return; }
    const rows = data as { metadata: any }[];
    const withInput = rows.filter((r) => r.metadata?.prompt_tokens != null);
    const withOutput = rows.filter((r) => r.metadata?.completion_tokens != null);
    const totalInput = withInput.reduce((s, r) => s + (r.metadata.prompt_tokens as number), 0);
    const totalOutput = withOutput.reduce((s, r) => s + (r.metadata.completion_tokens as number), 0);
    setRealTokenStats({
      calls: rows.length,
      avgInputTokens: withInput.length > 0 ? Math.round(totalInput / withInput.length) : null,
      avgOutputTokens: withOutput.length > 0 ? Math.round(totalOutput / withOutput.length) : null,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
    });
  }, []);

  const loadLatencyData = useCallback(async (uid?: string | null) => {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // auto_trade_strategy_run is system-level (user_id = NULL) — no uid filter
    const { data: stratData } = await supabase
      .from("compliance_log")
      .select("created_at, metadata")
      .eq("event_type", "auto_trade_strategy_run")
      .gte("created_at", since7d)
      .order("created_at", { ascending: true })
      .limit(10000);

    const stratDurations = (stratData ?? [])
      .map((e: any) => ({
        ts: new Date(e.created_at).getTime(),
        seconds: parseFloat(e.metadata?.elapsed_seconds ?? "0"),
      }))
      .filter((d) => d.seconds > 0);

    // Fallback: if strategy run events are sparse (agent crashing before it logs),
    // derive cycle time from consecutive auto_trade_run timestamps.
    // Only include intervals < 5 min to exclude gap outliers.
    if (stratDurations.length < 10) {
      const { data: runData } = await supabase
        .from("compliance_log")
        .select("created_at")
        .eq("event_type", "auto_trade_run")
        .gte("created_at", since7d)
        .order("created_at", { ascending: true })
        .limit(10000);

      if (runData && runData.length > 1) {
        const intervals = runData.slice(1).map((e: any, i: number) => ({
          ts: new Date(e.created_at).getTime(),
          seconds: (new Date(e.created_at).getTime() - new Date(runData[i].created_at).getTime()) / 1000,
        })).filter((d) => d.seconds > 0 && d.seconds < 300); // exclude gaps > 5 min
        setStratRunDurations([...stratDurations, ...intervals]);
        return;
      }
    }

    setStratRunDurations(stratDurations);
  }, []);

  const loadSurfaceScanLatency = useCallback(async (uid?: string | null) => {
    // surface_scan_complete metadata doesn't include elapsed_seconds.
    // Derive scan duration from auto_trade_run → surface_scan_complete time delta —
    // the scan is the first step in each run, so the delta is the scan latency.
    let runsQ = supabase
      .from("compliance_log")
      .select("id, created_at")
      .eq("event_type", "auto_trade_run")
      .order("created_at", { ascending: false })
      .limit(50);
    // auto_trade_run and surface_scan_complete are system-level (user_id = NULL) — no uid filter
    const { data: runs } = await runsQ;
    if (!runs || runs.length === 0) return;

    const durations: number[] = [];
    await Promise.all(
      runs.map(async (run) => {
        const windowEnd = new Date(new Date(run.created_at).getTime() + 60_000).toISOString();
        let scanQ = supabase
          .from("compliance_log")
          .select("created_at")
          .eq("event_type", "surface_scan_complete")
          .gte("created_at", run.created_at)
          .lte("created_at", windowEnd)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (uid) scanQ = (scanQ as any).eq("user_id", uid);
        const { data: scan } = await scanQ;
        if (scan) {
          const s = (new Date((scan as any).created_at).getTime() - new Date(run.created_at).getTime()) / 1000;
          if (s > 0 && s < 60) durations.push(s);
        }
      })
    );
    setScanDurations(durations);
  }, []);

  // Intentionally no uid filter — the trading agent is global (one cron, not per-user).
  // Gaps in auto_trade_run/skipped represent edge function crashes, not user-specific issues.
  const loadExecutionGaps = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("compliance_log")
      .select("created_at")
      .in("event_type", ["auto_trade_run", "auto_trade_skipped"])
      .gte("created_at", since)
      .order("created_at", { ascending: true });
    if (!data || data.length < 2) { setGapEvents([]); return; }
    // Compute median inter-run interval to set a dynamic threshold (3× median).
    // This avoids false alarms when the cron schedule changes (e.g. hourly vs 30s).
    const intervals: number[] = [];
    for (let i = 1; i < data.length; i++) {
      intervals.push((new Date(data[i].created_at).getTime() - new Date(data[i - 1].created_at).getTime()) / 60000);
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = Math.max(15, median * 3); // at least 15 min, or 3× median cadence
    const gaps: { from: string; to: string; gapMins: number }[] = [];
    for (let i = 1; i < data.length; i++) {
      const prev = new Date(data[i - 1].created_at).getTime();
      const curr = new Date(data[i].created_at).getTime();
      const gapMins = (curr - prev) / 60000;
      if (gapMins > threshold) gaps.push({ from: data[i - 1].created_at, to: data[i].created_at, gapMins });
    }
    setGapEvents(gaps);
  }, []);

  // Single data-load coordinator — all loaders go through here so there is exactly one
  // authority deciding what uid to use. Syncs viewUserIdRef for RT/poll closures.
  const loadAll = useCallback((uid: string | null) => {
    viewUserIdRef.current = uid;
    loadHeroStatus(uid);
    loadHeroFeed(uid);
    loadPerformance(uid);
    loadComplianceLast30d(uid);
    loadModelLatency(uid);
    loadActivity24h(uid);
    loadErrors24h(uid);
    loadErrors(uid);
    loadStrategies(uid);
    loadMemories(uid);
    loadLatencyData(uid);
    loadSurfaceScanLatency(uid);
    loadExecutionGaps();
    loadActiveModel();
    loadRealTokenStats();
  }, [
    loadHeroStatus, loadHeroFeed, loadPerformance, loadComplianceLast30d,
    loadModelLatency, loadActivity24h, loadErrors24h, loadErrors, loadStrategies,
    loadMemories, loadLatencyData, loadSurfaceScanLatency, loadExecutionGaps, loadActiveModel,
    loadRealTokenStats,
  ]);

  // Session init — fires once on mount. Gets userId for profile display + populates user list.
  // No data fetching here — loadAll handles that via the viewUserId effect below.
  // isAdmin is set to true immediately: AdminRoute in App.tsx already verified is_admin before
  // rendering this page, so the second DB query is redundant.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const uid = session?.user?.id ?? null;
      setUserId(uid);
      userIdRef.current = uid;
      setIsAuthenticated(!!session);
      setIsAdmin(true);
      if (uid) loadUserList();
    });
  }, [loadUserList]);

  // Single data load authority — fires on mount (viewUserId starts null = platform view)
  // and on every user-switcher change. Replaces the old mount load + admin effect.
  useEffect(() => {
    loadAll(viewUserId);
  }, [viewUserId, loadAll]);

  // Trace log effect — has its own filter state (traceDay) so stays independent
  useEffect(() => {
    setTracePage(1);
    setTraceExpanded(false);
    loadTraceLogs(viewUserId);
  }, [traceDay, viewUserId, loadTraceLogs]);

  // Decision history effect — has its own filter state so stays independent
  useEffect(() => {
    loadDecisionHistory(decisionDateFilter, decisionStatusFilter, viewUserId);
  }, [decisionDateFilter, decisionStatusFilter, viewUserId, loadDecisionHistory]);

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
            loadHeroStatus(viewUserIdRef.current);
            loadComplianceLast30d(viewUserIdRef.current);
          }

          if (ERROR_EVENTS.has(ev.event_type) || ev.severity === "error" || ev.severity === "critical" || ev.severity === "warning") {
            loadErrors(viewUserIdRef.current);
          }

          if (STRATEGY_SUSPENSION_EVENTS.has(ev.event_type)) {
            loadStrategies(viewUserIdRef.current);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        () => {
          loadHeroStatus(viewUserIdRef.current);
          loadDecisionHistory("30d", "all", viewUserIdRef.current);
          loadPerformance(viewUserIdRef.current);
          loadComplianceLast30d(viewUserIdRef.current);
        }
      )
      .subscribe();

    // 2-minute polling fallback — uses viewUserIdRef so it always matches the current view
    const poll = setInterval(() => loadAll(viewUserIdRef.current), 2 * 60 * 1000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, [loadAll, loadHeroStatus, loadDecisionHistory, loadErrors, loadStrategies, loadPerformance, loadComplianceLast30d]);

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

  const isPlatformView = isAdmin && viewUserId === null;

  const status = agentStatus(lastRunAt);

  const minsAgo = lastRunAt
    ? Math.floor((Date.now() - new Date(lastRunAt).getTime()) / 60000)
    : null;

  // Performance stats
  // viewUserId = specific user selected; null = platform view (all users) or own account (non-admin)
  const relevantStrategies = isAdmin
    ? (viewUserId ? strategies.filter((s) => s.user_id === viewUserId) : strategies)
    : (userId ? strategies.filter((s) => s.user_id === userId) : strategies.filter((s) => s.active));
  const tradedStrategyIds = new Set(allSettledTrades.map((t) => t.strategy_id).filter(Boolean));
  const strategyMap = new Map(relevantStrategies.map((s) => [s.id, s]));
  const STARTING_CAPITAL = tradedStrategyIds.size > 0
    ? Array.from(tradedStrategyIds).reduce((sum, sid) => sum + (strategyMap.get(sid!)?.starting_balance ?? 0), 0)
    : relevantStrategies.reduce((sum, s) => sum + (s.starting_balance ?? 0), 0);
  const settledCount = allSettledTrades.length;
  const totalPnl = allSettledTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  // ROI is only meaningful for a single user — hide in admin platform view
  const roi = (STARTING_CAPITAL > 0 && (!isAdmin || viewUserId !== null)) ? (totalPnl / STARTING_CAPITAL) * 100 : null;
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

  // Active model — must be declared before cost calculations that reference it
  const modelInfo = (activeModel && MODEL_COSTS[activeModel]) ? MODEL_COSTS[activeModel] : DEFAULT_MODEL_INFO;
  const modelLabel = modelInfo.label;
  const modelProviderLabel = modelInfo.provider;
  const LLM_INPUT_PER_M = modelInfo.input;
  const LLM_OUTPUT_PER_M = modelInfo.output;
  const unknownModel = !!activeModel && !MODEL_COSTS[activeModel];

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
      desc: "Executes orders to Kalshi",
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
      name: "Risk Halt",
      desc: "Global trading halt (halted by risk state or missing config) — per-trade blocks log under Guardrails",
      calls: toolCounts["auto_trade_skipped"] ?? 0,
      errors: toolCounts["strategy_auto_halted"] ?? 0,
    },
  ];

  // Memory derived stats
  const activeMemories = memories.filter((m) => m.is_active && !m.quarantined_at);
  // agent_memory uses is_active:false instead of a quarantined_at column
  const quarantinedMemories = memories.filter((m) => !m.is_active || !!m.quarantined_at);
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
  const filteredMemories = (() => {
    const sorted = memories
      .filter((m) => {
        if (memoryTypeFilter === "quarantined") return !m.is_active || !!m.quarantined_at;
        if (memoryTypeFilter !== "all") return m.memory_type === memoryTypeFilter;
        return true;
      })
      .sort((a, b) => {
        if (memorySortBy === "confidence") return b.confidence - a.confidence;
        if (memorySortBy === "confirmations") return b.confirmations - a.confirmations;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    // In "all" view: show top 5 active + all quarantined. Other filters show everything.
    if (memoryTypeFilter === "all") {
      const quarantined = sorted.filter((m) => !m.is_active || !!m.quarantined_at);
      const active = sorted.filter((m) => m.is_active && !m.quarantined_at);
      return [...active.slice(0, 5), ...quarantined];
    }
    return sorted;
  })();

  const hiddenActiveCount = memoryTypeFilter === "all"
    ? Math.max(0, activeMemories.length - 5)
    : 0;

  // Failure mode detection — uses errors24h (error/warning events from last 24h, server-fetched)
  const failureModes = detectFailureModes(errors24h, memories, toolCounts, runs6hCount, stratRuns24hCount, rateLimitCount24h ?? undefined, gapEvents, kalshiRateLimitCount24h ?? undefined);

  // 24h failure timeline — bucket all failure events by hour, include events array for drill-down
  const allFailureEventsFlat = [
    ...failureModes.llm_timeout.events,
    ...failureModes.kalshi_timeout.events,
    ...failureModes.llm_rate_limit.events,
    ...failureModes.kalshi_rate_limit.events,
    ...failureModes.exchange_error.events,
    ...failureModes.strategy_error.events,
    ...failureModes.pii_detected.events,
    ...failureModes.db_connection.events,
    ...failureModes.network_failure.events,
  ];
  const failureTimeline = (() => {
    const now = Date.now();
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const hourStart = now - (23 - i) * 3_600_000;
      const hourEnd = hourStart + 3_600_000;
      const hourStartDate = new Date(hourStart);
      const hourEndDate = new Date(hourEnd);
      const label = hourStartDate.toLocaleTimeString(undefined, { hour: "numeric" });
      const tooltipLabel = `${hourStartDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} – ${hourEndDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      const events = allFailureEventsFlat.filter((e) => {
        const t = new Date(e.created_at).getTime();
        return t >= hourStart && t < hourEnd;
      });
      return { hour: label, tooltipLabel, count: events.length, events };
    });
    // Scale green bars to 40% of the max red bar so they're always visible regardless of red scale.
    // If no failures at all, green bars default to height 1.
    const maxFailures = Math.max(...buckets.map((b) => b.count), 1);
    const greenHeight = Math.max(1, maxFailures * 0.4);
    return buckets.map((b) => ({
      ...b,
      barValue: b.count > 0 ? b.count : greenHeight,
    }));
  })();

  const totalFailures24h = Object.values(failureModes).reduce((s, m) => s + (m.events?.length ?? 0), 0);

  const cutoff24h = Date.now() - 86_400_000;
  const events24h = complianceLast30d.filter(
    (e) => new Date(e.created_at).getTime() >= cutoff24h
  );
  const runsToday = runs24hCount ?? events24h.filter((e) => e.event_type === "auto_trade_run").length;
  const scansToday = scans24hCount ?? events24h.filter((e) => e.event_type === "surface_scan_complete").length;
  const tradesFilledToday = tradesFilled24hCount ?? (
    events24h.filter((e) => e.event_type === "basket_completed").length +
    (primaryMode !== "live"
      ? decisionTrades.filter((t) => new Date(t.created_at).getTime() >= cutoff24h).length
      : 0)
  );
  const latestMemory = activeMemories[0] ?? null;
  const healthyCount = Object.values(failureModes).filter((m) => m.status === "ok").length;
  const totalHealthChecks = Object.keys(failureModes).length;

  // Latency derived stats
  const latencyNow = Date.now();
  // 7-day chart: 28 buckets of 6h each → covers full week with readable labels
  const latencyTrend = Array.from({ length: 28 }, (_, i) => {
    const bucketStart = latencyNow - (27 - i) * 6 * 3_600_000;
    const bucketEnd = bucketStart + 6 * 3_600_000;
    const bucket = stratRunDurations
      .filter((d) => d.ts >= bucketStart && d.ts < bucketEnd)
      .map((d) => d.seconds);
    return {
      hour: new Date(bucketStart).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }),
      avg: bucket.length > 0 ? bucket.reduce((s, v) => s + v, 0) / bucket.length : null,
    };
  });

  const sortedDurations = [...stratRunDurations.map((d) => d.seconds)].sort((a, b) => a - b);
  const p50CycleS = sortedDurations.length > 0 ? percentile(sortedDurations, 50) : null;
  const p95CycleS = sortedDurations.length > 0 ? percentile(sortedDurations, 95) : null;

  // Paper trades set filled_at ≈ created_at simultaneously; use abs to handle floating-point skew,
  // then treat values < 2s as paper-instant (live fills take seconds to minutes via Kalshi).
  const fillLatenciesMs = allSettledTrades
    .filter((t) => t.filled_at && t.created_at)
    .map((t) => Math.abs(new Date(t.filled_at!).getTime() - new Date(t.created_at).getTime()));
  const avgFillLatencyMs =
    fillLatenciesMs.length > 0
      ? fillLatenciesMs.reduce((s, v) => s + v, 0) / fillLatenciesMs.length
      : null;
  const fillIsPaper = avgFillLatencyMs !== null && avgFillLatencyMs < 2000;

  const settlementLatenciesMs = allSettledTrades
    .filter((t) => t.settled_at && t.filled_at)
    .map((t) => new Date(t.settled_at!).getTime() - new Date(t.filled_at!).getTime())
    .filter((ms) => ms >= 0);
  const avgSettlementMs =
    settlementLatenciesMs.length > 0
      ? settlementLatenciesMs.reduce((s, v) => s + v, 0) / settlementLatenciesMs.length
      : null;

  // Surface scan latency
  const avgScanS = scanDurations.length > 0
    ? scanDurations.reduce((s, v) => s + v, 0) / scanDurations.length
    : null;

  // Execution gap log URL — Supabase edge function logs page (timestamp URL params not supported by dashboard).
  // Opens the logs page; use the Supabase time picker to navigate to the gap window shown in the link text.
  const gapLogsUrl = (_from: string, _to: string) =>
    `https://supabase.com/dashboard/project/uyfnezxmgwitpzsrnkst/logs/edge-functions`;

  // Trace pagination
  const TRACE_PAGE_SIZE = 30;
  const TRACE_INITIAL = 10;
  const totalTracePages = traceExpanded ? Math.ceil(traceRuns.length / TRACE_PAGE_SIZE) : 1;
  const traceSlice = traceExpanded
    ? traceRuns.slice((tracePage - 1) * TRACE_PAGE_SIZE, tracePage * TRACE_PAGE_SIZE)
    : traceRuns.slice(0, TRACE_INITIAL);

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
        {isAdmin && (
          <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline">
            {isPlatformView ? `${userList.length} accounts` : `User ${viewUserId?.slice(0, 8)}…`}
          </span>
        )}
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

      {/* ── Admin Scope Bar ──────────────────────────────────────────────── */}
      {isAdmin && (
        <div className="border-b border-border bg-card/60 px-8 py-3 flex items-center justify-between gap-4">
          {/* Left: current scope */}
          <div className="flex items-center gap-3 min-w-0">
            <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${isPlatformView ? "bg-blue-400" : "bg-orange-400"}`} />
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">
                {isPlatformView ? "Platform View" : `User ${viewUserId?.slice(0, 8)}…`}
              </p>
              <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {isPlatformView
                  ? `Aggregated across all ${userList.length} registered accounts · per-account financials hidden`
                  : `${userList.find(u => u.id === viewUserId)?.strategyCount ?? 0} strategies · isolated account view`}
              </p>
            </div>
          </div>

          {/* Right: account switcher */}
          <div className="flex items-center gap-2 shrink-0">
            {!isPlatformView && (
              <button
                onClick={() => setViewUserId(null)}
                className="text-[11px] px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
              >
                ← Platform View
              </button>
            )}
            <Select
              value={viewUserId ?? "__platform__"}
              onValueChange={(v) => setViewUserId(v === "__platform__" ? null : v)}
            >
              <SelectTrigger className="h-8 text-xs w-[200px] font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__platform__">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-400 inline-block shrink-0" />
                    Platform View
                  </span>
                </SelectItem>
                <SelectSeparator />
                {userList.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-400 inline-block shrink-0" />
                      <span>{u.id === userId ? "Your account" : `User ${u.id.slice(0, 8)}…`}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="max-w-[1100px] mx-auto px-8 py-8 space-y-6">

        {/* ── System Failure Modes (always visible, top of page) ────── */}
        <Section
          title="System Health"
          action={
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {totalFailures24h > 0
                ? `${totalFailures24h} event${totalFailures24h !== 1 ? "s" : ""} · last 24h`
                : "All clear · last 24h"} · {healthyCount}/{totalHealthChecks} healthy
            </span>
          }
        >
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-4 gap-3">
              {(
                [
                  "llm_timeout",
                  "kalshi_timeout",
                  "llm_rate_limit",
                  "kalshi_rate_limit",
                  "cost_spike",
                  "exchange_error",
                  "strategy_error",
                  "pii_detected",
                  "db_connection",
                  "network_failure",
                  "memory_pressure",
                  "execution_gap",
                ] as const
              ).map((key) => {
                const mode = failureModes[key];
                const detail = FAILURE_MODE_DETAILS[key];
                const { status: modeStatus } = mode;
                const dotLabel = modeStatus === "critical" ? "✖" : modeStatus === "warning" ? "▲" : "●";
                const dotText = modeStatus === "critical" ? "text-red-500" : modeStatus === "warning" ? "text-yellow-500" : "text-emerald-500";
                const lastOccurrence = mode.lastAt ? relativeTime(mode.lastAt) : "Clean";
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedFailureMode(key)}
                    className="rounded-xl border border-border p-4 text-left hover:bg-secondary/30 transition-colors"
                  >
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`text-[11px] font-bold ${dotText}`}>{dotLabel}</span>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">{detail.title}</p>
                    </div>
                    <p className="text-lg font-bold tabular-nums">
                      {key === "cost_spike"
                        ? (mode.status !== "ok" ? (mode.extra ?? "—") : "Normal")
                        : key === "memory_pressure" ? `${mode.count} quarant.`
                        : key === "execution_gap" ? (mode.count === 0 ? "0" : `${mode.count} gap${mode.count !== 1 ? "s" : ""}`)
                        : `${mode.count}`}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {key === "cost_spike"
                        ? (mode.status !== "ok" ? `${mode.count} calls · last 6h` : "no spike detected")
                        : key === "memory_pressure" ? mode.extra ?? ""
                        : key === "execution_gap" ? (mode.count === 0 ? "Clean" : mode.extra ?? (mode.lastAt ? relativeTime(mode.lastAt) : "—"))
                        : lastOccurrence}
                    </p>
                  </button>
                );
              })}
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-2">
                24h Uptime
                <span className="normal-case tracking-normal opacity-60 lowercase"> · green = clean · red = failures · click red bars for details</span>
              </p>
              <ResponsiveContainer width="100%" height={70}>
                <BarChart data={failureTimeline} barSize={10}>
                  <XAxis dataKey="hour" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={3} />
                  <YAxis hide domain={[0, "dataMax"]} />
                  <Tooltip
                    contentStyle={{ fontSize: 10, borderRadius: 6 }}
                    content={({ payload }: any) => {
                      if (!payload?.length) return null;
                      const entry = payload[0]?.payload;
                      if (!entry) return null;
                      return (
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-sm text-[10px]">
                          <p className="font-medium mb-1 text-foreground">{entry.tooltipLabel}</p>
                          {entry.count > 0 ? (
                            <p className="text-red-400">{entry.count} failure event{entry.count !== 1 ? "s" : ""}</p>
                          ) : (
                            <p className="text-emerald-500">Clean — no failures</p>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="barValue"
                    radius={[2, 2, 0, 0]}
                    style={{ cursor: "pointer" }}
                    onClick={(data: any) => {
                      if (data.count > 0) setSelectedTimelineHour({ label: data.hour, events: data.events });
                    }}
                  >
                    {failureTimeline.map((entry, index) => (
                      <Cell
                        key={index}
                        fill={entry.count > 0 ? "#ef4444" : "#22c55e"}
                        fillOpacity={entry.count > 0 ? 0.75 : 0.45}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>

        {/* ── 1. KPI Hero ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4">
          {/* ROI — per-user view only; platform view shows account scope card */}
          {isPlatformView ? (
            <div className="rounded-2xl bg-card apple-shadow px-8 py-6 flex flex-col gap-1">
              <p className="text-[11px] text-muted-foreground uppercase tracking-widest">Accounts</p>
              <p className="text-4xl font-bold tabular-nums">{userList.length}</p>
              <p className="text-[11px] text-muted-foreground">registered accounts</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-card apple-shadow px-8 py-6 flex flex-col gap-1">
              <p className="text-[11px] text-muted-foreground uppercase tracking-widest">Return on Capital</p>
              <p className={`text-4xl font-bold tabular-nums ${roi === null ? "text-muted-foreground" : roi >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {roi === null ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}${STARTING_CAPITAL > 0 ? ` on $${STARTING_CAPITAL.toLocaleString()}` : ""} · ${settledCount} trades`}
              </p>
            </div>
          )}

          {/* Win Rate */}
          <div className="rounded-2xl bg-card apple-shadow px-8 py-6 flex flex-col gap-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-widest">Win Rate</p>
            <p className={`text-4xl font-bold tabular-nums ${winRate !== null && winRate >= 55 ? "text-emerald-500" : winRate !== null && winRate >= 40 ? "text-yellow-500" : "text-muted-foreground"}`}>
              {winRate !== null ? `${winRate.toFixed(0)}%` : "—"}
            </p>
          </div>

          {/* Agent Status */}
          <div className="rounded-2xl bg-card apple-shadow px-8 py-6 flex flex-col gap-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-widest">Agent Status</p>
            <div className="flex items-center gap-2.5 mt-1">
              <span className={`h-3.5 w-3.5 rounded-full shrink-0 ${status.dot}`} />
              <p className={`text-4xl font-bold ${status.color}`}>{status.label}</p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {minsAgo !== null ? `Last run: ${minsAgo}m ago` : "No heartbeat recorded"}
            </p>
          </div>
        </div>

        {/* ── 2. Equity Curve — hidden in platform view (meaningless across users) */}
        {!isPlatformView && <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
          <div className="px-6 pt-5 pb-2 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Portfolio Equity</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cumulative P&L · settled trades
              </p>
            </div>
            {equityData.length > 0 && roi !== null && (
              <div className="text-right">
                <span className={`text-sm font-bold tabular-nums ${roi >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {roi >= 0 ? "+" : ""}{roi.toFixed(2)}%
                </span>
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                </p>
              </div>
            )}
          </div>
          {equityData.length < 2 ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
              Not enough data yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={equityData} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <defs>
                  <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${((v / STARTING_CAPITAL) * 100).toFixed(1)}%`} width={52} />
                <Tooltip
                  formatter={(value: number) => [`${((value / STARTING_CAPITAL) * 100).toFixed(2)}% ($${value.toFixed(2)})`, "ROI"]}
                  contentStyle={{ fontSize: 11, borderRadius: 8 }}
                />
                <Area
                  type="monotone"
                  dataKey="cumPnl"
                  stroke="hsl(var(--primary))"
                  fill="url(#pnlGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>}

        {/* ── 3. Operational Summary | Agent Intelligence ───────────── */}
        <div className="grid grid-cols-2 gap-4">

          {/* Left: Operational Summary */}
          <div className="rounded-2xl bg-card apple-shadow px-6 py-5">
            <h2 className="text-sm font-semibold mb-4">Last 24 Hours</h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Cron Runs", value: runsToday.toLocaleString(), sub: "auto-trade runs" },
                { label: "Markets Scanned", value: scansToday.toLocaleString(), sub: "surface scans" },
                { label: "Trades Placed", value: tradesFilledToday.toString(), sub: "new positions" },
                { label: "Open Positions", value: openPositionCount.toString(), sub: isPlatformView ? "across all accounts" : `$${openPositionValue.toFixed(0)} at risk` },
              ].map(({ label, value, sub }) => (
                <div key={label}>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
                  <p className="text-2xl font-bold tabular-nums">{value}</p>
                  <p className="text-[10px] text-muted-foreground">{sub}</p>
                </div>
              ))}
            </div>
            {!isPlatformView && todayPnl !== 0 && (
              <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Today's P&L</span>
                <span className={`text-sm font-bold tabular-nums ${todayPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}
                </span>
              </div>
            )}
          </div>

          {/* Right: Agent Intelligence */}
          <div className="rounded-2xl bg-card apple-shadow px-6 py-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Agent Intelligence</h2>
              <button
                onClick={() => setMemoryPanelOpen(true)}
                className="text-[11px] hover:opacity-80 transition-opacity"
                style={{ color: "#f97316" }}
              >
                View All →
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Active Lessons</p>
                <p className="text-2xl font-bold tabular-nums">{activeMemories.length}</p>
                <p className="text-[10px] text-muted-foreground">{quarantinedMemories.length} quarantined</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Avg Confidence</p>
                <p className={`text-2xl font-bold tabular-nums ${avgConfidence !== null && avgConfidence >= 0.6 ? "text-emerald-500" : avgConfidence !== null && avgConfidence >= 0.4 ? "text-yellow-500" : "text-muted-foreground"}`}>
                  {avgConfidence !== null ? `${(avgConfidence * 100).toFixed(0)}%` : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground">across all memory types</p>
              </div>
            </div>
            {latestMemory && (
              <div className="rounded-xl bg-secondary/40 px-4 py-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${MEMORY_TYPE_COLORS[latestMemory.memory_type] ?? "bg-secondary text-muted-foreground"}`}>
                    {MEMORY_TYPE_LABELS[latestMemory.memory_type] ?? latestMemory.memory_type}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{(latestMemory.confidence * 100).toFixed(0)}% confidence</span>
                </div>
                <p className="text-[12px] font-medium leading-snug line-clamp-2">{latestMemory.title}</p>
              </div>
            )}
            {!latestMemory && (
              <p className="text-xs text-muted-foreground">
                {isAuthenticated === false ? "Sign in to view agent memory." : "Loading memory…"}
              </p>
            )}
          </div>
        </div>

        {/* ── 5. Cost & Efficiency ─────────────────────────────────────── */}
        <Section
          title="Cost & Efficiency"
          action={
            isPlatformView ? (
              <span className="text-[10px] text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                aggregate · all {userList.length} accounts
              </span>
            ) : viewUserId ? (
              <span className="text-[10px] text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">
                User {viewUserId.slice(0, 8)}… only
              </span>
            ) : undefined
          }
        >
          <div className="p-6 space-y-5">
            {/* ── Top row: daily snapshot ─────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                Daily
                <span className="text-[10px] font-medium bg-secondary px-2 py-0.5 rounded-full ml-2">
                  {modelLabel} · {modelProviderLabel}
                  {unknownModel && <span className="text-yellow-500 ml-1" title={`Unknown model: ${activeModel} — costs are estimated`}>*</span>}
                </span>
              </p>
              <div className="grid grid-cols-4 gap-4">
                <div className="rounded-xl border border-border p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">LLM Spend</p>
                  <p className="text-xl font-bold tabular-nums">${dailyLLMSpend.toFixed(4)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">avg daily · last 30d</p>
                </div>
                <div className="rounded-xl border border-border p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Cost / Decision</p>
                  <p className="text-xl font-bold tabular-nums">
                    {(() => {
                      const c = ((QUALIFY_INPUT_TOKENS / 1_000_000) * LLM_INPUT_PER_M + (QUALIFY_OUTPUT_TOKENS / 1_000_000) * LLM_OUTPUT_PER_M);
                      return c < 0.000001 ? "<$0.000001" : `$${c.toFixed(6)}`;
                    })()}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{avgTokensPerDecision.toLocaleString()} tokens est.</p>
                </div>
                <div className="rounded-xl border border-border p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Cost / Trade</p>
                  <p className="text-xl font-bold tabular-nums">
                    {costPerTrade !== null ? costPerTrade < 0.0001 ? "<$0.0001" : `$${costPerTrade.toFixed(4)}` : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">avg · last 30d</p>
                </div>
                <div className="rounded-xl border border-border p-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Cost / Run</p>
                  <p className="text-xl font-bold tabular-nums">
                    {costPerRun !== null ? costPerRun < 0.000001 ? "<$0.000001" : `$${costPerRun.toFixed(6)}` : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {autoTradeRunCount > 0 ? `${avgStrategiesPerRun.toFixed(1)} strat/run avg` : "no run data"}
                  </p>
                </div>
              </div>
            </div>
            {/* ── Bottom row: 30-day volume ─────────────────────────────── */}
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Last 30 Days</p>
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">LLM Calls</p>
                  <p className="text-base font-bold tabular-nums">
                    {(realTokenStats?.calls ?? llmCallsLast30d).toLocaleString()}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {realTokenStats ? "measured · qualify events" : "strategy evaluations est."}
                  </p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Input Tokens</p>
                  <p className="text-base font-bold tabular-nums">
                    {(() => {
                      const n = realTokenStats ? realTokenStats.totalInputTokens : inputTokens30d;
                      return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${(n / 1_000).toFixed(0)}K`;
                    })()}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {realTokenStats?.avgInputTokens != null
                      ? `${realTokenStats.avgInputTokens.toLocaleString()} / call measured`
                      : `~${QUALIFY_INPUT_TOKENS.toLocaleString()} / call est.`}
                  </p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Output Tokens</p>
                  <p className="text-base font-bold tabular-nums">
                    {(() => {
                      const n = realTokenStats ? realTokenStats.totalOutputTokens : outputTokens30d;
                      return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${(n / 1_000).toFixed(0)}K`;
                    })()}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {realTokenStats?.avgOutputTokens != null
                      ? `${realTokenStats.avgOutputTokens} / call measured`
                      : `~${QUALIFY_OUTPUT_TOKENS} / call est.`}
                  </p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Total Spend</p>
                  <p className="text-base font-bold tabular-nums">${totalSpend30d.toFixed(4)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">${(LLM_INPUT_PER_M / 1000).toFixed(3)}/1K in · ${(LLM_OUTPUT_PER_M / 1000).toFixed(3)}/1K out</p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-3">Automated Pipeline <span className="normal-case tracking-normal lowercase opacity-60">(not the 14 conversational agent tools)</span></p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 text-[11px] font-medium text-muted-foreground">Tool</th>
                    <th className="text-left py-2 text-[11px] font-medium text-muted-foreground">What it does</th>
                    <th className="text-right py-2 text-[11px] font-medium text-muted-foreground">Calls (30d)</th>
                    <th className="text-right py-2 text-[11px] font-medium text-muted-foreground">Errors (30d)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tools.map((tool) => (
                    <tr key={tool.name} className="hover:bg-secondary/20 transition-colors">
                      <td className="py-2.5 text-[12px] font-medium">{tool.name}</td>
                      <td className="py-2.5 text-[11px] text-muted-foreground">{tool.desc}</td>
                      <td className="py-2.5 text-right text-[12px] tabular-nums">{tool.calls.toLocaleString()}</td>
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

        {/* ── Latency ──────────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
          <div className="px-6 pt-5 pb-4">
            <h2 className="text-sm font-semibold">Latency</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Strategy execution · order fill · settlement</p>
          </div>

          {/* 5 KPI cards */}
          <div className="grid grid-cols-5 gap-0 border-t" style={{ borderColor: "#2e2720" }}>
            {/* p50 */}
            <div className="px-6 py-4 border-r" style={{ borderColor: "#2e2720" }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">p50 Cycle</p>
              <p className={`text-2xl font-bold tabular-nums ${p50CycleS === null ? "text-muted-foreground" : p50CycleS <= 3 ? "text-emerald-500" : p50CycleS <= 8 ? "text-yellow-500" : "text-red-500"}`}>
                {fmtSeconds(p50CycleS)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">median run</p>
            </div>
            {/* p95 */}
            <div className="px-6 py-4 border-r" style={{ borderColor: "#2e2720" }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">p95 Cycle</p>
              <p className={`text-2xl font-bold tabular-nums ${p95CycleS === null ? "text-muted-foreground" : p95CycleS <= 8 ? "text-yellow-500" : "text-red-500"}`}>
                {fmtSeconds(p95CycleS)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">95th pct run</p>
            </div>
            {/* Avg Cycle */}
            <div className="px-6 py-4 border-r" style={{ borderColor: "#2e2720" }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Avg Cycle</p>
              <p className={`text-2xl font-bold tabular-nums ${avgCycleMs === null ? "text-muted-foreground" : avgCycleMs < 8000 ? "text-emerald-500" : avgCycleMs < 20000 ? "text-yellow-500" : "text-red-500"}`}>
                {cycleLabel ?? "—"}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">run → last event avg</p>
            </div>
            {/* Settlement */}
            <div className="px-6 py-4 border-r" style={{ borderColor: "#2e2720" }}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Settlement</p>
              <p className="text-2xl font-bold tabular-nums text-muted-foreground">
                {fmtMs(avgSettlementMs)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">fill → resolve avg</p>
            </div>
            {/* Market Scan */}
            <div className="px-6 py-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Market Scan</p>
              <p className={`text-2xl font-bold tabular-nums ${avgScanS === null ? "text-muted-foreground" : avgScanS <= 5 ? "text-emerald-500" : avgScanS <= 15 ? "text-yellow-500" : "text-red-500"}`}>
                {avgScanS !== null ? `${avgScanS.toFixed(1)}s` : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">surface scan avg</p>
            </div>
          </div>

          {/* 24h latency trend */}
          <div className="px-6 pt-4 pb-5 border-t" style={{ borderColor: "#2e2720" }}>
            <p className="text-[10px] text-muted-foreground mb-3">Strategy run duration · last 7 days (avg per 6h window, seconds)</p>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={latencyTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="hour" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={3} />
                <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} width={28} tickFormatter={(v) => `${v}s`} />
                <Tooltip
                  formatter={(value: number | null) => [value !== null ? `${value.toFixed(2)}s` : "—", "Avg duration"]}
                  contentStyle={{ fontSize: 10, borderRadius: 6 }}
                />
                <Line
                  type="monotone"
                  dataKey="avg"
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  dot={{ r: 2, fill: "hsl(var(--primary))" }}
                  activeDot={{ r: 4 }}
                  connectNulls={true}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ── 6. Recent Decisions ──────────────────────────────────────── */}
        <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent Decisions</h2>
            <button
              onClick={() => setShowFullHistory(true)}
              className="text-[11px] text-primary hover:opacity-80 transition-opacity"
            >
              Full history →
            </button>
          </div>
          <div className="p-4 grid grid-cols-3 gap-3">
            {decisionTrades.slice(0, 6).map((t) => {
              const pnl = t.pnl ?? 0;
              const hasPnl = t.pnl !== null && t.pnl !== 0 && t.status === "settled";
              const isBullish = t.action === "buy" || t.side === "yes";
              const label = t.market_question
                ? t.market_question.slice(0, 80) + (t.market_question.length > 80 ? "…" : "")
                : t.ticker ?? "—";
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTrade(t)}
                  className="rounded-xl border border-border p-4 text-left hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${isBullish ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
                      {t.action?.toUpperCase()} {t.side?.toUpperCase()}
                    </span>
                    {hasPnl && (
                      <span className={`text-[11px] font-bold tabular-nums ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] font-medium leading-snug text-foreground line-clamp-2 mb-2">{label}</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">{t.strategy ?? "—"}</span>
                    <span className="text-muted-foreground/40 text-[10px]">·</span>
                    <span className="text-[10px] text-muted-foreground">{fmtDate(t.created_at)}</span>
                  </div>
                </button>
              );
            })}
            {decisionTrades.length === 0 && (
              <div className="col-span-3 py-8 text-center text-sm text-muted-foreground">No trades found.</div>
            )}
          </div>
        </div>

        {/* ── 7. Errors — grouped by type, deduplicated ── */}
        <Section
          title="Errors"
          action={
            <span className="text-[10px] text-muted-foreground">
              {guardrailEvents.length + errorEvents.length === 0 ? "Clean" : `${guardrailEvents.length + errorEvents.length} events`}
            </span>
          }
        >
          {guardrailEvents.length === 0 && errorEvents.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-xs text-muted-foreground">No errors or guardrail events in the log.</p>
            </div>
          ) : (
            <ErrorGroupPanel guardrailEvents={guardrailEvents} errorEvents={errorEvents} onSelectError={setSelectedError} />
          )}
        </Section>

        {/* ── System Details toggle ─────────────────────────────────── */}
        <button
          onClick={() => setShowDetails((v) => !v)}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-border text-[11px] font-medium text-muted-foreground hover:bg-secondary/30 transition-colors"
        >
          {showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {showDetails ? "Hide" : "Show"} System Details
          <span className="ml-1 text-[10px] opacity-60">
            traces · decision history
          </span>
        </button>

        {/* ── System Details (deep-dive technical sections) ──────── */}
        {showDetails && (
          <div className="space-y-6">

            {/* Execution Traces */}
            <Section
              title="Execution Traces"
              action={
                <div className="flex items-center gap-3">
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
                            traceDay === iso ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="date"
                    value={traceDay}
                    onChange={(e) => setTraceDay(e.target.value)}
                    className="text-[10px] bg-secondary border border-border rounded-lg px-2 py-1 text-muted-foreground"
                  />
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
                  <div className="py-10 text-center text-sm text-muted-foreground">No auto-trade runs found.</div>
                ) : (
                  traceSlice.map((run) => {
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
                          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-[140px]">{fmtDate(run.created_at)}</span>
                          <span className="text-[12px] font-medium shrink-0">Auto-Trade Run</span>
                          <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">{run.message}</span>
                        </button>
                        {isOpen && (
                          <div className="bg-secondary/20 divide-y divide-border/50">
                            {!children ? (
                              <div className="px-10 py-2 text-[11px] text-muted-foreground">Loading…</div>
                            ) : children.length === 0 ? (
                              <div className="px-10 py-2 text-[11px] text-muted-foreground">No child events within 90s.</div>
                            ) : (
                              children.map((child) => (
                                <div key={child.id} className="px-10 py-2 flex items-start gap-2.5">
                                  <span className={`mt-[5px] h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[child.severity] ?? "bg-muted-foreground/40"}`} />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-[11px] font-medium ${SEVERITY_CLASSES[child.severity] ?? "text-muted-foreground"}`}>
                                        {EVENT_TYPE_LABELS[child.event_type] ?? child.event_type}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground/50 tabular-nums ml-auto shrink-0">{fmtTime(child.created_at)}</span>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{child.message}</p>
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
              {/* Trace expand / pagination controls */}
              {traceRuns.length > TRACE_INITIAL && (
                <div className="px-6 py-3 border-t border-border flex items-center gap-3">
                  {!traceExpanded ? (
                    <button
                      onClick={() => { setTraceExpanded(true); setTracePage(1); }}
                      className="text-[11px] font-medium hover:opacity-80 transition-opacity"
                      style={{ color: "#f97316" }}
                    >
                      Show 30 ↓
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setTraceExpanded(false)}
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Collapse ↑
                      </button>
                      {totalTracePages > 1 && (
                        <div className="flex items-center gap-1 ml-auto">
                          <button
                            onClick={() => setTracePage((p) => Math.max(1, p - 1))}
                            disabled={tracePage === 1}
                            className="text-[10px] px-2 py-1 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-30 font-medium"
                          >
                            ←
                          </button>
                          {Array.from({ length: totalTracePages }, (_, i) => i + 1).map((p) => (
                            <button
                              key={p}
                              onClick={() => setTracePage(p)}
                              className={`text-[10px] px-2.5 py-1 rounded-lg transition-colors font-medium ${
                                tracePage === p
                                  ? "bg-card text-foreground shadow-sm border border-border"
                                  : "bg-secondary text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {p}
                            </button>
                          ))}
                          <button
                            onClick={() => setTracePage((p) => Math.min(totalTracePages, p + 1))}
                            disabled={tracePage === totalTracePages}
                            className="text-[10px] px-2 py-1 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors disabled:opacity-30 font-medium"
                          >
                            →
                          </button>
                          <span className="text-[10px] text-muted-foreground ml-1">
                            {(tracePage - 1) * TRACE_PAGE_SIZE + 1}–{Math.min(tracePage * TRACE_PAGE_SIZE, traceRuns.length)} of {traceRuns.length}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {!traceExpanded && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      showing 10 of {traceRuns.length}
                    </span>
                  )}
                </div>
              )}
            </Section>

            {/* Decision History */}
            <Section
              title="Decision History"
              action={
                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                    {(["today", "7d", "30d", "all"] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setDecisionDateFilter(f)}
                        className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                          decisionDateFilter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                    {(["all", "filled", "settled"] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setDecisionStatusFilter(f)}
                        className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                          decisionStatusFilter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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
                      <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground">Time</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Market</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Action</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Size</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Strategy</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Entry</th>
                      <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">P&L</th>
                      <th className="text-center px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {decisionTrades.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-center py-12 text-sm text-muted-foreground">No trades found.</td>
                      </tr>
                    ) : (
                      decisionTrades.map((t) => {
                        const actionLabel = `${t.action?.toUpperCase()} ${t.side?.toUpperCase()}`;
                        const isBullish = t.action === "buy" || t.side === "yes";
                        const label = t.ticker ?? (t.market_question ? t.market_question.slice(0, 40) + (t.market_question.length > 40 ? "…" : "") : "—");
                        const fullQ = t.market_question ?? t.ticker ?? "";
                        const hasPnl = t.pnl !== null;
                        const pnl = t.pnl ?? 0;
                        return (
                          <tr key={t.id} onClick={() => setSelectedTrade(t)} className="hover:bg-secondary/30 transition-colors cursor-pointer">
                            <td className="px-6 py-2.5">
                              <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">{fmtDate(t.created_at)}</span>
                            </td>
                            <td className="px-3 py-2.5 max-w-[200px]">
                              <span className="text-[12px] text-foreground" title={fullQ}>{label}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`text-[11px] font-semibold uppercase ${isBullish ? "text-emerald-500" : "text-red-500"}`}>{actionLabel}</span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className="text-[11px] tabular-nums text-muted-foreground">${t.amount?.toFixed(2) ?? "—"}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="text-[11px] text-muted-foreground">{t.strategy ?? "—"}</span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className="text-[11px] tabular-nums text-muted-foreground">{t.price}¢</span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {hasPnl ? (
                                <span className={`text-[12px] font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                                </span>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <Badge variant="secondary" className="text-[10px] rounded-full font-normal">{t.status}</Badge>
                            </td>
                            <td className="px-6 py-2.5 max-w-[180px]">
                              {t.notes ? (
                                <span className="text-[11px] text-muted-foreground truncate block" title={t.notes}>
                                  {t.notes.slice(0, 50)}{t.notes.length > 50 ? "…" : ""}
                                </span>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">—</span>
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

            {/* System Health pills (bottom row) */}
            <div className="flex items-center gap-3 pb-4">
              <SystemPill
                label="Trading Mode"
                value={primaryMode.charAt(0).toUpperCase() + primaryMode.slice(1)}
                valueClass={primaryMode === "live" ? "text-emerald-500" : "text-yellow-500"}
              />
              <SystemPill label="LLM" value={`${modelLabel} via ${modelProviderLabel}`} />
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
        )}


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
              <>
                {filteredMemories.map((mem) => {
                  const isExpanded = expandedMemoryId === mem.id;
                  const conf = mem.confidence;
                  const stratName = mem.strategy_id
                    ? strategies.find((s) => s.id === mem.strategy_id || mem.strategy_id?.startsWith(s.id.replace(/-[0-9a-f]{8}$/, "")))?.name ?? mem.strategy_id
                    : null;
                  return (
                    <div key={mem.id} className="px-6 py-4">
                      {/* Top row */}
                      <div className="flex items-start gap-2 mb-2 flex-wrap">
                        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${MEMORY_TYPE_COLORS[mem.memory_type] ?? "bg-secondary text-muted-foreground"}`}>
                          {MEMORY_TYPE_LABELS[mem.memory_type] ?? mem.memory_type}
                        </span>
                        {stratName && (
                          <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-mono">
                            {stratName}
                          </span>
                        )}
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
                })}
                {hiddenActiveCount > 0 && (
                  <div className="px-6 py-4 text-center">
                    <p className="text-[11px] text-muted-foreground">
                      {hiddenActiveCount} more active {hiddenActiveCount === 1 ? "memory" : "memories"} —{" "}
                      <button
                        className="text-primary hover:opacity-80 transition-opacity"
                        onClick={() => setMemoryTypeFilter("lesson")}
                      >
                        use type filters above to see all
                      </button>
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </>
    )}

    {/* ── Failure Mode Detail Panel ───────────────────────────────── */}
    {selectedFailureMode && (() => {
      const mode = failureModes[selectedFailureMode];
      const detail = FAILURE_MODE_DETAILS[selectedFailureMode];
      if (!detail || !mode) return null;
      const { status } = mode;
      return (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={() => setSelectedFailureMode(null)}
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
                    status === "critical" ? "bg-red-500/10 text-red-500" :
                    status === "warning"  ? "bg-yellow-500/10 text-yellow-500" :
                    "bg-emerald-500/10 text-emerald-500"
                  }`}>
                    {status}
                  </span>
                  <span className="text-xs text-muted-foreground">last 24h</span>
                </div>
                <h3 className="text-sm font-semibold">{detail.title}</h3>
              </div>
              <button
                onClick={() => setSelectedFailureMode(null)}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-lg leading-none mt-0.5"
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">What This Means</p>
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-foreground leading-relaxed">{detail.description}</p>
                </div>
              </div>

              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Suggested Resolution</p>
                <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-4">
                  <p className="text-[12px] text-foreground leading-relaxed">{detail.resolution}</p>
                </div>
              </div>

              {mode.events && mode.events.length > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">
                    Recent Events ({mode.events.length})
                  </p>
                  <div className="rounded-xl bg-secondary/40 divide-y divide-border overflow-hidden">
                    {mode.events.slice(0, 8).map((ev) => (
                      <div key={ev.id} className="px-4 py-2.5">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-[10px] font-medium ${SEVERITY_CLASSES[ev.severity] ?? "text-muted-foreground"}`}>
                            {ev.severity}
                          </span>
                          <span className="text-[10px] text-muted-foreground ml-auto">{relativeTime(ev.created_at)}</span>
                        </div>
                        <p className="text-[11px] text-foreground leading-snug">{ev.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(selectedFailureMode === "cost_spike" || selectedFailureMode === "memory_pressure") && (
                <div className="rounded-xl bg-secondary/40 p-4">
                  <p className="text-[12px] text-muted-foreground">
                    {selectedFailureMode === "cost_spike"
                      ? `${mode.count} strategy evaluations in the last 6h (${mode.extra ?? "—"} per 6h window)`
                      : `${mode.count} quarantined memories · ${failureModes.memory_pressure.extra ?? ""}`}
                  </p>
                  {selectedFailureMode === "memory_pressure" && (
                    <>
                      <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                        compact-memory summarizes active memories (saves tokens) and merges clusters of 3+ related entries. It does not reduce the quarantine count — quarantined entries must be reset directly in the DB.
                      </p>
                      <button
                        disabled={clearingMemory}
                        onClick={async () => {
                          setClearingMemory(true);
                          const { data: { session } } = await supabase.auth.getSession();
                          await fetch(
                            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compact-memory`,
                            { method: "POST", headers: { Authorization: `Bearer ${session?.access_token}` } }
                          ).catch(() => {});
                          setClearingMemory(false);
                          loadAll(viewUserId);
                          setSelectedFailureMode(null);
                        }}
                        className="w-full mt-2 py-2.5 rounded-xl bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
                      >
                        {clearingMemory ? "Running compact-memory…" : "Run compact-memory"}
                      </button>
                    </>
                  )}
                </div>
              )}
              {selectedFailureMode === "execution_gap" && gapEvents.length > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Gap Windows ({gapEvents.length})</p>
                  <div className="rounded-xl bg-yellow-500/10 border border-yellow-500/20 p-3 mb-3">
                    <p className="text-[11px] text-yellow-400 leading-relaxed">
                      Gaps = edge function ran but logged nothing. The crash happened before any DB write.
                      Only Supabase Edge Function logs can reveal the cause.
                    </p>
                  </div>
                  <div className="rounded-xl bg-secondary/40 divide-y divide-border overflow-hidden">
                    {gapEvents.map((g, i) => (
                      <div key={i} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold tabular-nums text-yellow-500">{Math.round(g.gapMins)} min gap</p>
                          <p className="text-[10px] text-muted-foreground">{relativeTime(g.to)}</p>
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          <p className="text-[10px] text-muted-foreground">{fmtDate(g.from)} → {fmtDate(g.to)}</p>
                          <a
                            href={gapLogsUrl(g.from, g.to)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Set Supabase time picker to: ${fmtDate(g.from)} – ${fmtDate(g.to)}`}
                            className="text-[10px] text-primary hover:opacity-80 transition-opacity shrink-0 ml-2"
                          >
                            Open logs ↗
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    })()}

    {/* ── Full Trade History Modal ────────────────────────── */}
    {showFullHistory && (
      <div
        className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 backdrop-blur-sm"
        onClick={() => setShowFullHistory(false)}
      >
        <div
          className="bg-card w-full max-w-5xl mx-auto my-6 rounded-2xl apple-shadow flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <h3 className="text-sm font-semibold">Trade History</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">{decisionTrades.length} trades · {decisionDateFilter === "all" ? "all time" : `last ${decisionDateFilter}`}</p>
            </div>
            <div className="flex items-center gap-3">
              {/* Date filter */}
              <div className="flex items-center bg-secondary rounded-full p-0.5 gap-0.5">
                {(["today", "7d", "30d", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setDecisionDateFilter(f)}
                    className={`text-[10px] px-2.5 py-1 rounded-full transition-colors font-medium capitalize ${
                      decisionDateFilter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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
                      decisionStatusFilter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowFullHistory(false)}
                className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>

          {/* Table body — scrollable */}
          <div className="overflow-y-auto flex-1">
            {decisionTrades.length === 0 ? (
              <div className="py-20 text-center text-sm text-muted-foreground">No trades found.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b border-border z-10">
                  <tr>
                    <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">Time</th>
                    <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Market</th>
                    <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Direction</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Size</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Entry</th>
                    <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Strategy</th>
                    <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">P&L</th>
                    <th className="text-center px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Outcome</th>
                    <th className="text-left px-6 py-2.5 text-[11px] font-medium text-muted-foreground">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {decisionTrades.map((t) => {
                    const isBullish = t.action === "buy" || t.side === "yes";
                    const hasPnl = t.pnl !== null;
                    const pnl = t.pnl ?? 0;
                    const won = t.status === "settled" && pnl > 0;
                    const lost = t.status === "settled" && pnl <= 0;
                    const label = t.market_question ?? t.ticker ?? "—";
                    const shortLabel = label.length > 60 ? label.slice(0, 60) + "…" : label;
                    return (
                      <tr
                        key={t.id}
                        onClick={() => { setSelectedTrade(t); setShowFullHistory(false); }}
                        className="hover:bg-secondary/30 transition-colors cursor-pointer"
                      >
                        <td className="px-6 py-2.5 whitespace-nowrap">
                          <span className="text-[11px] text-muted-foreground tabular-nums">{fmtDate(t.created_at)}</span>
                        </td>
                        <td className="px-3 py-2.5 max-w-[260px]">
                          <span className="text-[12px] text-foreground" title={label}>{shortLabel}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={`text-[11px] font-semibold uppercase ${isBullish ? "text-emerald-500" : "text-red-500"}`}>
                            {t.action?.toUpperCase()} {t.side?.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="text-[11px] tabular-nums text-muted-foreground">${t.amount?.toFixed(2) ?? "—"}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="text-[11px] tabular-nums text-muted-foreground">{t.price}¢</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="text-[11px] text-muted-foreground">{t.strategy ?? "—"}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {hasPnl ? (
                            <span className={`text-[12px] font-semibold tabular-nums ${pnl > 0 ? "text-emerald-500" : "text-red-500"}`}>
                              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {t.status === "settled" ? (
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${won ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
                              {won ? "Won" : "Lost"}
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">{t.status}</span>
                          )}
                        </td>
                        <td className="px-6 py-2.5 max-w-[200px]">
                          <span className="text-[11px] text-muted-foreground truncate block" title={t.notes ?? undefined}>
                            {t.notes ? (t.notes.length > 60 ? t.notes.slice(0, 60) + "…" : t.notes) : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    )}

    {/* ── Timeline Hour Drill-Down Modal ───────────────────────────── */}
    {selectedTimelineHour && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        onClick={() => setSelectedTimelineHour(null)}
      >
        <div
          className="bg-card rounded-2xl apple-shadow w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <h3 className="text-sm font-semibold">Failures at {selectedTimelineHour.label}</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">{selectedTimelineHour.events.length} event{selectedTimelineHour.events.length !== 1 ? "s" : ""} in this hour</p>
            </div>
            <button onClick={() => setSelectedTimelineHour(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
          </div>
          <div className="overflow-y-auto flex-1 divide-y divide-border">
            {selectedTimelineHour.events
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
              .map((ev) => {
                const category = Object.entries(failureModes).find(([, m]) => m.events.some((e) => e.id === ev.id))?.[0];
                const categoryTitle = category ? FAILURE_MODE_DETAILS[category]?.title : null;
                return (
                  <div key={ev.id} className="px-6 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-semibold uppercase ${SEVERITY_CLASSES[ev.severity] ?? "text-muted-foreground"}`}>
                        {ev.severity}
                      </span>
                      {categoryTitle && (
                        <span className="text-[10px] bg-secondary text-muted-foreground px-1.5 py-0.5 rounded-full">{categoryTitle}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">{fmtTime(ev.created_at)}</span>
                    </div>
                    <p className="text-[12px] text-foreground leading-snug">{ev.message}</p>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
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

// ── ErrorGroupPanel ───────────────────────────────────────────────────────────
// Groups flat compliance_log events by event_type, deduplicates repetitive entries,
// and shows count + most recent per group for fast triage.

function ErrorGroupPanel({
  guardrailEvents,
  errorEvents,
  onSelectError,
}: {
  guardrailEvents: ComplianceEvent[];
  errorEvents: ComplianceEvent[];
  onSelectError: (ev: ComplianceEvent) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  function groupByType(events: ComplianceEvent[]) {
    const map = new Map<string, ComplianceEvent[]>();
    for (const ev of events) {
      const key = ev.event_type;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    // Sort groups by most recent occurrence desc
    return Array.from(map.entries())
      .map(([type, evs]) => ({
        type,
        count: evs.length,
        latest: evs.reduce((a, b) => a.created_at > b.created_at ? a : b),
        events: evs.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      }))
      .sort((a, b) => b.latest.created_at.localeCompare(a.latest.created_at));
  }

  const guardrailGroups = groupByType(guardrailEvents);
  const errorGroups = groupByType(errorEvents);

  function renderGroup(
    { type, count, latest, events }: ReturnType<typeof groupByType>[0],
    sectionPrefix: string
  ) {
    const groupKey = `${sectionPrefix}:${type}`;
    const isOpen = expandedGroup === groupKey;
    const label = EVENT_TYPE_LABELS[type] ?? type;
    const severityText =
      latest.severity === "critical" ? "text-red-500" :
      latest.severity === "error"    ? "text-red-400" :
      latest.severity === "warning"  ? "text-yellow-500" :
      "text-muted-foreground";
    const dot =
      latest.severity === "critical" || latest.severity === "error" ? "bg-red-500" :
      latest.severity === "warning" ? "bg-yellow-500" : "bg-muted-foreground/40";

    // Truncate the most representative message (strip UUIDs/hashes for readability)
    const cleanMsg = latest.message
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "…")
      .slice(0, 120);

    return (
      <div key={groupKey} className="border-b border-border last:border-0">
        <button
          className="w-full px-6 py-3 flex items-start gap-3 hover:bg-secondary/20 transition-colors text-left"
          onClick={() => setExpandedGroup(isOpen ? null : groupKey)}
        >
          <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dot}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">{label}</span>
              {count > 1 && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${severityText} bg-current/10`}>
                  ×{count}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{relativeTime(latest.created_at)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{cleanMsg}</p>
          </div>
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/40 shrink-0 mt-0.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </button>
        {isOpen && (
          <div className="px-6 pb-3 space-y-1">
            {events.slice(0, 10).map((ev) => (
              <button
                key={ev.id}
                onClick={() => onSelectError(ev)}
                className="w-full rounded-lg bg-secondary/40 px-3 py-2 text-left hover:bg-secondary/70 transition-colors"
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-[10px] font-medium ${SEVERITY_CLASSES[ev.severity] ?? "text-muted-foreground"}`}>{ev.severity}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{fmtDate(ev.created_at)}</span>
                </div>
                <p className="text-[11px] text-foreground leading-snug">{ev.message}</p>
              </button>
            ))}
            {events.length > 10 && (
              <p className="text-[10px] text-muted-foreground text-center pt-1">+{events.length - 10} more</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {guardrailGroups.length > 0 && (
        <div>
          <p className="px-6 pt-4 pb-2 text-[10px] text-muted-foreground uppercase tracking-wide">
            Guardrails Fired <span className="normal-case tracking-normal">— expected behavior, system blocked something</span>
          </p>
          {guardrailGroups.map((g) => renderGroup(g, "guardrail"))}
        </div>
      )}
      {errorGroups.length > 0 && (
        <div>
          <p className="px-6 pt-4 pb-2 text-[10px] text-muted-foreground uppercase tracking-wide">
            Unexpected Errors <span className="normal-case tracking-normal">— things that should not happen</span>
          </p>
          {errorGroups.map((g) => renderGroup(g, "error"))}
        </div>
      )}
    </div>
  );
}

// ── Latency helpers ───────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtSeconds(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// ── detectFailureModes ────────────────────────────────────────────────────────

function detectFailureModes(
  events: ComplianceEvent[],
  memories: MemoryEntry[],
  toolCounts: Record<string, number>,
  runs6hCount: number | null = null,
  runs24hCount: number | null = null,
  rateLimitCount?: number,
  gaps: { from: string; to: string; gapMins: number }[] = [],
  kalshiRateLimitCount?: number
): Record<string, { status: "ok" | "warning" | "critical"; events: ComplianceEvent[]; count: number; lastAt: string | null; extra?: string }> {
  const now = Date.now();
  const cutoff24h = now - 86_400_000;

  const last24h = events.filter((e) => new Date(e.created_at).getTime() >= cutoff24h);

  const llmTimeoutEvents = last24h.filter((e) =>
    (e.event_type === "api_timeout" && /llm|qualify|openrouter|anthropic|openai/i.test(e.message)) ||
    /llm.*timed?\s*out|qualify.*timeout/i.test(e.message)
  );
  const kalshiTimeoutEvents = last24h.filter((e) =>
    (e.event_type === "api_timeout" && /kalshi|GET.*market|series|portfolio/i.test(e.message)) ||
    /kalshi.*timed?\s*out|kalshi.*timeout/i.test(e.message)
  );

  const rateLimitEvents = last24h.filter((e) =>
    e.event_type === "llm_rate_limit" ||
    (/(\b429\b|rate.?limit|quota.?exceeded|too.?many.?request)/i.test(e.message) &&
     !/kalshi/i.test(e.message))
  );

  // 24h events — used for timeline bars
  const kalshiRateLimitEvents = last24h.filter((e) =>
    e.event_type === "kalshi_rate_limit" ||
    e.event_type === "kalshi_circuit_open" ||
    (e.event_type === "api_timeout" && /kalshi/i.test(e.message) && /\b429\b/i.test(e.message)) ||
    (/kalshi/i.test(e.message) && /\b429\b|rate.?limit|too.?many.?request/i.test(e.message))
  );

  const dbEvents = last24h.filter((e) =>
    /connection.?refused|ECONNREFUSED|socket|db.?error|database.?error|connection.?pool/i.test(e.message) &&
    (e.severity === "error" || e.severity === "critical")
  );

  const networkEvents = last24h.filter((e) =>
    /fetch.?failed|network.?error|ENETUNREACH|ETIMEDOUT|DNS|name.?resolution/i.test(e.message) &&
    (e.severity === "error" || e.severity === "critical") &&
    e.event_type !== "api_timeout"
  );

  const exchangeErrorEvents = last24h.filter((e) =>
    /parse.?error|unexpected.?token|invalid.?json|schema|validation/i.test(e.message) &&
    /kalshi|market.?data|GET.*market|series|closeTime|yes_ask|no_bid/i.test(e.message) &&
    e.severity !== "info"
  );
  const strategyErrorEvents = last24h.filter((e) =>
    (e.event_type === "auto_trade_strategy_error" ||
      (/parse.?error|unexpected.?token|invalid.?json|cannot.?read|undefined.*null/i.test(e.message) &&
       !/kalshi|market.?data|GET.*market/i.test(e.message))) &&
    e.severity !== "info"
  );

  const piiEvents = last24h.filter((e) => {
    const emailRe = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;
    const phoneRe = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
    return emailRe.test(e.message) || phoneRe.test(e.message);
  });

  // runs6hCount and runs24hCount come from dedicated server-side COUNT queries
  // Baseline uses last-24h ÷ 4 (not 30d total) — 30d average understates activity for newer systems
  const last6hRuns = runs6hCount ?? 0;
  const avg6hRuns = runs24hCount !== null ? runs24hCount / 4 : (toolCounts["auto_trade_strategy_run"] ?? 0) / (30 * 4);
  const spikeRatio = (runs6hCount !== null && runs24hCount !== null && avg6hRuns > 0) ? last6hRuns / avg6hRuns : null;

  const quarantined = memories.filter((m) => !m.is_active || !!m.quarantined_at);
  const activeCount = memories.filter((m) => m.is_active && !m.quarantined_at).length;

  function lastAt(evs: ComplianceEvent[]): string | null {
    return evs.length > 0 ? evs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0].created_at : null;
  }

  return {
    llm_timeout: {
      events: llmTimeoutEvents,
      count: llmTimeoutEvents.length,
      lastAt: lastAt(llmTimeoutEvents),
      status: llmTimeoutEvents.length >= 5 ? "critical" : llmTimeoutEvents.length >= 1 ? "warning" : "ok",
    },
    kalshi_timeout: {
      events: kalshiTimeoutEvents,
      count: kalshiTimeoutEvents.length,
      lastAt: lastAt(kalshiTimeoutEvents),
      status: kalshiTimeoutEvents.length >= 5 ? "critical" : kalshiTimeoutEvents.length >= 1 ? "warning" : "ok",
    },
    llm_rate_limit: {
      events: rateLimitEvents,
      count: rateLimitCount !== undefined ? rateLimitCount : rateLimitEvents.length,
      lastAt: lastAt(rateLimitEvents),
      status: (rateLimitCount !== undefined ? rateLimitCount : rateLimitEvents.length) >= 1 ? "critical" : "ok",
    },
    kalshi_rate_limit: {
      events: kalshiRateLimitEvents,
      count: kalshiRateLimitCount !== undefined ? kalshiRateLimitCount : kalshiRateLimitEvents.length,
      lastAt: lastAt(kalshiRateLimitEvents),
      status: (kalshiRateLimitCount !== undefined ? kalshiRateLimitCount : kalshiRateLimitEvents.length) >= 1 ? "critical" : "ok",
    },
    cost_spike: {
      events: [],
      count: last6hRuns,
      lastAt: null,
      extra: spikeRatio !== null ? `${spikeRatio.toFixed(1)}× 24h avg` : "insufficient data",
      status: spikeRatio !== null && spikeRatio > 4 ? "critical" : spikeRatio !== null && spikeRatio > 2 ? "warning" : "ok",
    },
    exchange_error: {
      events: exchangeErrorEvents,
      count: exchangeErrorEvents.length,
      lastAt: lastAt(exchangeErrorEvents),
      status: exchangeErrorEvents.length >= 10 ? "critical" : exchangeErrorEvents.length >= 3 ? "warning" : "ok",
    },
    strategy_error: {
      events: strategyErrorEvents,
      count: strategyErrorEvents.length,
      lastAt: lastAt(strategyErrorEvents),
      status: strategyErrorEvents.length >= 10 ? "critical" : strategyErrorEvents.length >= 3 ? "warning" : "ok",
    },
    pii_detected: {
      events: piiEvents,
      count: piiEvents.length,
      lastAt: lastAt(piiEvents),
      status: piiEvents.length >= 1 ? "critical" : "ok",
    },
    db_connection: {
      events: dbEvents,
      count: dbEvents.length,
      lastAt: lastAt(dbEvents),
      status: dbEvents.length >= 3 ? "critical" : dbEvents.length >= 1 ? "warning" : "ok",
    },
    network_failure: {
      events: networkEvents,
      count: networkEvents.length,
      lastAt: lastAt(networkEvents),
      status: networkEvents.length >= 5 ? "critical" : networkEvents.length >= 1 ? "warning" : "ok",
    },
    memory_pressure: {
      events: [],
      count: quarantined.length,
      lastAt: quarantined.length > 0
        ? (() => {
            const sorted = [...quarantined].sort((a, b) => {
              const aT = new Date(a.quarantined_at ?? a.created_at).getTime();
              const bT = new Date(b.quarantined_at ?? b.created_at).getTime();
              return bT - aT;
            });
            return sorted[0]?.quarantined_at ?? sorted[0]?.created_at ?? null;
          })()
        : null,
      extra: `${activeCount} active`,
      status: quarantined.length >= 20 ? "critical" : quarantined.length >= 5 ? "warning" : "ok",
    },
    execution_gap: {
      events: [],
      count: gaps.length,
      lastAt: gaps.length > 0 ? gaps[gaps.length - 1].to : null,
      extra: gaps.length > 0
        ? `max ${Math.round(Math.max(...gaps.map((g) => g.gapMins)))} min`
        : undefined,
      status: gaps.length === 0 ? "ok" : gaps.some((g) => g.gapMins > 30) ? "critical" : "warning",
    },
  };
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
