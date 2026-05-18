import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bot, Activity, Clock, TrendingUp, Brain, Shield, AlertTriangle, CheckCircle, XCircle, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComplianceEvent {
  id: string;
  created_at: string;
  event_type: string;
  severity: string;
  message: string;
  trade_id: string | null;
}

interface MemoryEntry {
  id: string;
  title: string;
  memory_type: string;
  confidence: number;
  exposed_confidence?: number;
  confirmations: number;
  contradictions: number;
  strategy_id: string | null;
  tags: string[] | null;
}

interface Strategy {
  id: string;
  name: string;
  active: boolean;
  mode: string;
  suspended_until: string | null;
  suspension_reason: string | null;
}

interface SettledTrade {
  id: string;
  market_question: string;
  strategy: string | null;
  strategy_id: string | null;
  side: string;
  price: number;
  pnl: number | null;
  settled_at: string | null;
  resolution: string | null;
}

interface StatusBar {
  lastRunAt: string | null;
  openPositionCount: number;
  openPositionValue: number;
  todayPnl: number;
  memoryCount: number;
  isHalted: boolean;
  haltReason: string | null;
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
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SEVERITY_CLASSES: Record<string, string> = {
  info:     "text-muted-foreground",
  warning:  "text-yellow-500",
  error:    "text-red-500",
  critical: "text-red-500 font-semibold",
};

const SEVERITY_DOT: Record<string, string> = {
  info:     "bg-muted-foreground/40",
  warning:  "bg-yellow-500",
  error:    "bg-red-500",
  critical: "bg-red-500",
};

const MEMORY_TYPE_CLASSES: Record<string, string> = {
  lesson:      "bg-primary/10 text-primary",
  pattern:     "bg-purple-500/10 text-purple-500",
  mistake:     "bg-red-500/10 text-red-500",
  success:     "bg-emerald-500/10 text-emerald-500",
  market_note: "bg-yellow-500/10 text-yellow-500",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  auto_trade_run:              "Auto-Trade Run",
  auto_trade_strategy_run:     "Strategy Run",
  auto_trade_strategy_error:   "Strategy Error",
  auto_settle_run:             "Auto-Settle",
  auto_reflect_run:            "Auto-Reflect",
  order_submitted:             "Order Submitted",
  order_filled:                "Order Filled",
  order_cancelled:             "Order Cancelled",
  risk_check_passed:           "Risk Check ✓",
  risk_check_failed:           "Risk Check ✗",
  position_limit_hit:          "Position Limit Hit",
  daily_loss_limit_hit:        "Daily Loss Limit",
  strategy_suspended_sharpe:   "Strategy Suspended",
  strategy_suspended_drawdown: "Strategy Suspended",
  strategy_suspended_hitrate:  "Strategy Suspended",
  strategy_loss_streak:        "Loss Streak",
  strategy_resumed:            "Strategy Resumed",
  memory_quarantined:          "Memory Quarantined",
  trade_settled:               "Trade Settled",
};

// ── ObservabilityPage ──────────────────────────────────────────────────────────

export default function ObservabilityPage() {
  const [status, setStatus] = useState<StatusBar>({
    lastRunAt: null,
    openPositionCount: 0,
    openPositionValue: 0,
    todayPnl: 0,
    memoryCount: 0,
    isHalted: false,
    haltReason: null,
  });
  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyWinRates, setStrategyWinRates] = useState<Record<string, { wins: number; total: number }>>({});
  const [trades, setTrades] = useState<SettledTrade[]>([]);
  const [liveIndicator, setLiveIndicator] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);

  // Pulse live indicator
  useEffect(() => {
    const t = setInterval(() => setLiveIndicator(v => !v), 1200);
    return () => clearInterval(t);
  }, []);

  // Document title
  useEffect(() => {
    document.title = "Observability · TradeAgent";
    return () => { document.title = "TradeAgent"; };
  }, []);

  // ── Data loaders ──────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [lastRunRes, openRes, pnlRes, memCountRes, haltRes] = await Promise.all([
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
      (supabase.from("agent_memory" as any) as any)
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
      (supabase.from("risk_state" as any) as any)
        .select("is_trading_halted, halt_reason")
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const openTrades: { amount: number }[] = openRes.data ?? [];
    const pnlTrades: { pnl: number | null }[] = pnlRes.data ?? [];

    setStatus({
      lastRunAt: lastRunRes.data?.created_at ?? null,
      openPositionCount: openTrades.length,
      openPositionValue: openTrades.reduce((s, t) => s + (t.amount ?? 0), 0),
      todayPnl: pnlTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
      memoryCount: memCountRes.count ?? 0,
      isHalted: haltRes.data?.is_trading_halted ?? false,
      haltReason: haltRes.data?.halt_reason ?? null,
    });
  }, []);

  const loadEvents = useCallback(async () => {
    const { data } = await supabase
      .from("compliance_log")
      .select("id, created_at, event_type, severity, message, trade_id")
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setEvents(data as ComplianceEvent[]);
  }, []);

  const loadMemories = useCallback(async () => {
    const { data } = await (supabase.from("agent_memory" as any) as any)
      .select("id, title, memory_type, confidence, confirmations, contradictions, strategy_id, tags")
      .eq("is_active", true)
      .order("confidence", { ascending: false })
      .limit(8);
    if (data) setMemories(data as MemoryEntry[]);
  }, []);

  const loadStrategies = useCallback(async () => {
    const [stratRes, tradesRes] = await Promise.all([
      supabase
        .from("strategies")
        .select("id, name, active, mode, suspended_until, suspension_reason"),
      supabase
        .from("trades")
        .select("strategy_id, pnl")
        .eq("status", "settled")
        .not("strategy_id", "is", null)
        .order("settled_at", { ascending: false })
        .limit(200),
    ]);

    if (stratRes.data) setStrategies(stratRes.data as Strategy[]);

    if (tradesRes.data) {
      const rates: Record<string, { wins: number; total: number }> = {};
      for (const t of tradesRes.data as { strategy_id: string; pnl: number | null }[]) {
        const sid = t.strategy_id;
        if (!sid) continue;
        if (!rates[sid]) rates[sid] = { wins: 0, total: 0 };
        rates[sid].total++;
        if ((t.pnl ?? 0) > 0) rates[sid].wins++;
      }
      setStrategyWinRates(rates);
    }
  }, []);

  const loadTrades = useCallback(async () => {
    const { data } = await supabase
      .from("trades")
      .select("id, market_question, strategy, strategy_id, side, price, pnl, settled_at, resolution")
      .eq("status", "settled")
      .order("settled_at", { ascending: false })
      .limit(15);
    if (data) setTrades(data as SettledTrade[]);
  }, []);

  // Initial load
  useEffect(() => {
    loadStatus();
    loadEvents();
    loadMemories();
    loadStrategies();
    loadTrades();
  }, [loadStatus, loadEvents, loadMemories, loadStrategies, loadTrades]);

  // Real-time subscriptions
  useEffect(() => {
    const channel = supabase
      .channel("obs-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "compliance_log" }, (payload) => {
        const ev = payload.new as ComplianceEvent;
        setEvents(prev => [ev, ...prev.slice(0, 49)]);
        setNewEventIds(prev => {
          const next = new Set(prev);
          next.add(ev.id);
          setTimeout(() => setNewEventIds(s => { const n = new Set(s); n.delete(ev.id); return n; }), 3000);
          return next;
        });
        loadStatus();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        loadStatus();
        loadTrades();
        loadStrategies();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadStatus, loadTrades, loadStrategies]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isSuspended = (s: Strategy) =>
    s.suspended_until && new Date(s.suspended_until) > new Date();

  const strategyStatus = (s: Strategy): { label: string; cls: string } => {
    if (isSuspended(s)) return { label: "Suspended", cls: "bg-red-500/10 text-red-500" };
    if (!s.active) return { label: "Inactive", cls: "bg-secondary text-muted-foreground" };
    return { label: "Active", cls: "bg-emerald-500/10 text-emerald-500" };
  };

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
            className={`h-2 w-2 rounded-full transition-opacity duration-500 ${liveIndicator ? "bg-emerald-500" : "bg-emerald-500/30"}`}
          />
          <span className="text-xs text-muted-foreground font-medium">Live</span>
        </div>
      </header>

      {/* ── Status Bar ───────────────────────────────────────────────────── */}
      <div className="border-b border-border px-8 py-3 flex items-center gap-8 overflow-x-auto scrollbar-none">
        {status.isHalted && (
          <div className="flex items-center gap-1.5 shrink-0">
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
            <span className="text-xs font-semibold text-red-500 uppercase tracking-wide">
              HALTED{status.haltReason ? ` — ${status.haltReason}` : ""}
            </span>
          </div>
        )}
        <StatusPill
          icon={<Clock className="h-3 w-3" />}
          label="Last run"
          value={status.lastRunAt ? relativeTime(status.lastRunAt) : "—"}
        />
        <StatusPill
          icon={<Activity className="h-3 w-3" />}
          label="Open positions"
          value={`${status.openPositionCount} ($${status.openPositionValue.toFixed(0)})`}
        />
        <StatusPill
          icon={<TrendingUp className="h-3 w-3" />}
          label="Today's P&L"
          value={`${status.todayPnl >= 0 ? "+" : ""}$${status.todayPnl.toFixed(2)}`}
          valueClass={status.todayPnl >= 0 ? "text-emerald-500" : "text-red-500"}
        />
        <StatusPill
          icon={<Brain className="h-3 w-3" />}
          label="Active memories"
          value={`${status.memoryCount} lessons`}
        />
      </div>

      {/* ── Main grid ────────────────────────────────────────────────────── */}
      <div className="px-8 py-6 grid grid-cols-[420px_1fr] gap-6 max-w-[1400px] mx-auto">

        {/* ── LEFT: Live Event Feed ───────────────────────────────────────── */}
        <div className="flex flex-col gap-0 rounded-2xl bg-card apple-shadow overflow-hidden" style={{ maxHeight: "calc(100vh - 200px)", minHeight: 500 }}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Live Event Feed</h2>
            </div>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
              {events.length} events
            </span>
          </div>
          <div
            ref={feedRef}
            className="overflow-y-auto flex-1 divide-y divide-border"
          >
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
                <Activity className="h-8 w-8 text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">Waiting for events…</p>
              </div>
            ) : events.map((ev) => (
              <div
                key={ev.id}
                className={`px-4 py-2.5 transition-colors duration-1000 ${newEventIds.has(ev.id) ? "bg-primary/5" : "hover:bg-secondary/30"}`}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-[5px] h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[ev.severity] ?? "bg-muted-foreground/40"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[11px] font-medium ${SEVERITY_CLASSES[ev.severity] ?? "text-muted-foreground"}`}>
                        {EVENT_TYPE_LABELS[ev.event_type] ?? ev.event_type}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0 ml-auto">
                        {fmtTime(ev.created_at)}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5 line-clamp-2">
                      {ev.message}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT column ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-6">

          {/* Agent Brain */}
          <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Brain className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Agent Brain</h2>
              <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full ml-auto">
                Top {memories.length} by confidence
              </span>
            </div>
            <div className="divide-y divide-border">
              {memories.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <p className="text-sm text-muted-foreground">No active memories.</p>
                </div>
              ) : memories.map((m) => {
                const conf = Math.round(((m.exposed_confidence != null ? m.exposed_confidence : m.confidence) ?? 0) * 100);
                return (
                  <div key={m.id} className="px-5 py-3 hover:bg-secondary/30 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1.5">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${MEMORY_TYPE_CLASSES[m.memory_type] ?? "bg-secondary text-muted-foreground"}`}>
                            {m.memory_type}
                          </span>
                          {m.strategy_id && (
                            <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">
                              {m.strategy_id}
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] text-foreground leading-snug line-clamp-2">{m.title}</p>
                        <div className="mt-2 flex items-center gap-3">
                          <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all"
                              style={{ width: `${conf}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{conf}%</span>
                          <span className="text-[10px] text-emerald-500 tabular-nums shrink-0">✓{m.confirmations}</span>
                          <span className="text-[10px] text-red-500 tabular-nums shrink-0">✗{m.contradictions}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Strategy Health */}
          <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Strategy Health</h2>
            </div>
            <div className="divide-y divide-border">
              {strategies.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <p className="text-sm text-muted-foreground">No strategies found.</p>
                </div>
              ) : strategies.map((s) => {
                const stat = strategyStatus(s);
                const wr = strategyWinRates[s.id];
                const winRate = wr && wr.total > 0 ? Math.round((wr.wins / wr.total) * 100) : null;
                return (
                  <div key={s.id} className="px-5 py-3.5 flex items-center gap-4 hover:bg-secondary/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{s.name}</span>
                        <Badge variant="secondary" className={`text-[10px] rounded-full font-normal ${stat.cls}`}>
                          {stat.label}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px] rounded-full font-normal">
                          {s.mode}
                        </Badge>
                      </div>
                      {isSuspended(s) && s.suspended_until && (
                        <p className="text-[11px] text-red-500/70 mt-0.5">
                          Resumes {relativeTime(s.suspended_until)} · {s.suspension_reason ?? ""}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {winRate !== null ? (
                        <div>
                          <span className={`text-sm font-semibold tabular-nums ${winRate >= 60 ? "text-emerald-500" : winRate >= 40 ? "text-yellow-500" : "text-red-500"}`}>
                            {winRate}%
                          </span>
                          <p className="text-[10px] text-muted-foreground">{wr!.total} settled</p>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">No data</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>

      {/* ── Recent Trade Lifecycle ────────────────────────────────────────── */}
      <div className="px-8 pb-10 max-w-[1400px] mx-auto">
        <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Recent Trade Lifecycle</h2>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full ml-auto">
              Last {trades.length} settled
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-2.5 text-[11px] font-medium text-muted-foreground">Market</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Strategy</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Side</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Entry</th>
                  <th className="text-center px-3 py-2.5 text-[11px] font-medium text-muted-foreground">Resolution</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-medium text-muted-foreground">P&L</th>
                  <th className="text-right px-5 py-2.5 text-[11px] font-medium text-muted-foreground">Settled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-sm text-muted-foreground">
                      No settled trades yet.
                    </td>
                  </tr>
                ) : trades.map((t) => {
                  const pnl = t.pnl ?? 0;
                  const hasPnl = t.pnl !== null;
                  return (
                    <tr key={t.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-5 py-3 max-w-[300px]">
                        <span className="text-[12px] text-foreground line-clamp-2 leading-snug">
                          {t.market_question}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-[11px] text-muted-foreground">{t.strategy ?? "—"}</span>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`text-[11px] font-medium uppercase ${t.side === "yes" ? "text-emerald-500" : "text-red-500"}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-[11px] text-muted-foreground tabular-nums">{t.price}¢</span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {t.resolution ? (
                          <span className={`text-[11px] font-medium ${t.resolution === "yes" ? "text-emerald-500" : t.resolution === "no" ? "text-red-500" : "text-muted-foreground"}`}>
                            {t.resolution.toUpperCase()}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {hasPnl ? (
                          <span className={`text-[12px] font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                          {t.settled_at ? fmtDate(t.settled_at) : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
}

// ── StatusPill ────────────────────────────────────────────────────────────────

function StatusPill({
  icon,
  label,
  value,
  valueClass = "text-foreground",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-[12px] font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}
