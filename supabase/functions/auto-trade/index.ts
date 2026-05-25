import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { langfuseIngest, traceEvent, generationEvent } from "../_shared/langfuse.ts";
import { captureException, captureMessage } from "../_shared/sentry.ts";
import { checkEntitlement, type SubscriptionRow } from "../_shared/billing.ts";
import { importMasterKey, decryptSecret, type EncryptedSecret } from "../_shared/encryption.ts";

/**
 * auto-trade: Autonomous trading loop — deterministic per-strategy orchestration.
 *
 * Architecture:
 *  - Code determines WHAT to look at and WHEN (reads signals, surface_alerts,
 *    strategy_config, portfolio — all filtered server-side before LLM sees anything)
 *  - LLM makes ONE decision per opportunity: QUALIFY or REJECT
 *  - Code routes to execute_basket (S-001) or execute_trade (S-002/003/004)
 *
 * This eliminates the core risk of prompt-based orchestration: the LLM can no
 * longer skip risk checks, use the wrong execution path, or hallucinate opportunities.
 *
 * Kill switch: strategy_config.is_halted — set automatically after
 * max_consecutive_failures errors. Reset manually via SQL or UI.
 *
 * Scheduled: every 5 minutes via pg_cron.
 */

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 min — auto-release stuck locks (longest strategy loop is ~90s)
const QUALIFY_TIMEOUT_MS = 15_000; // max 15s for LLM qualify/reject call
const KALSHI_RETRY_DELAY_MS = 500; // single retry delay for Kalshi API calls
const CIRCUIT_TRIP_THRESHOLD = 5; // consecutive post-retry Kalshi failures before circuit opens
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000; // 10 min — circuit auto-resets after this window
const MIN_KALSHI_REQUEST_SPACING_MS = 100; // 10 req/sec max — stay well under Kalshi rate limits

// Module-level throttle state — shared across all Kalshi calls within a single edge function invocation
let lastKalshiRequestMs = 0;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StrategyConfig {
  strategy_id: string;
  min_edge_cents: number;
  min_liquidity_score: number;
  min_composite_score: number;
  max_position_usd: number;
  min_position_usd: number;
  max_legs: number;
  basket_timeout_seconds: number;
  min_post_fill_edge_cents: number;
  min_days_to_close: number;
  max_days_to_close: number;
  max_consecutive_failures: number;
  consecutive_failures: number;
  is_halted: boolean;
  halt_reason: string | null;
}

interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
}

interface StrategyResult {
  strategy_id: string;
  strategy_name: string;
  mode: string;
  status: "completed" | "skipped" | "error" | "halted";
  action?: string;   // "basket_executed" | "trade_executed" | "no_setup" | "halted"
  details?: string;
  error?: string;
  elapsed_seconds?: string;
}

// ─── Ticker Date-Time Parser ──────────────────────────────────────────────────
// Extracts settlement date-time from Kalshi tickers for position aging.
// Formats handled:
//   KXFED-26JUN-T3.75              → 2026-06-30T18:00:00Z (FED, last day of month, 18:00 UTC)
//   KXCHCUTS-26MAY07-T60000        → 2026-05-07T00:00:00Z
//   KXETHD-26APR2617-T2339.99     → 2026-04-26T17:00:00Z (day + HH)
//   KXINX-26APR23H1600-B7112      → 2026-04-23T16:00:00Z (day + H + HHMM)
// Returns null if the ticker format is unrecognized (e.g. E2E-SYNTH-TEST-1).

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function parseSettlementDate(ticker: string): Date | null {
  if (!ticker || !ticker.startsWith("KX")) return null;

  // Pattern: KX[A-Z]+-(\d{2})(JAN|FEB|...|DEC)(\d{1,2})?(H\d{4})?[-T]
  const match = ticker.match(/KX[A-Z]+-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{1,2})?(H(\d{4}))?[-T]/);
  if (!match) return null;

  const yearStr = match[1];
  const monthStr = match[2];
  const dayStr = match[3];
  const hourStr = match[5]; // the HHMM part after H

  const year = 2000 + parseInt(yearStr, 10);
  const month = MONTH_MAP[monthStr];

  if (month === undefined) return null;

  let day = dayStr ? parseInt(dayStr, 10) : lastDayOfMonth(year, month);
  let hour = 0;
  let minute = 0;

  if (hourStr && hourStr.length === 4) {
    hour = parseInt(hourStr.slice(0, 2), 10);
    minute = parseInt(hourStr.slice(2, 4), 10);
  }

  // FED series without explicit time defaults to 18:00 UTC
  if (!hourStr && ticker.startsWith("KXFED-")) {
    hour = 18;
  }

  // If no day provided, use last day of month
  if (!dayStr) {
    day = lastDayOfMonth(year, month);
  }

  // Clamp day to valid range
  day = Math.min(day, lastDayOfMonth(year, month));

  return new Date(Date.UTC(year, month, day, hour, minute, 0));
}

// ─── Weighted Position Counter ────────────────────────────────────────────────
// Counts open positions with tiered weighting for day-trade prioritization.
// Near-term positions (settling ≤ 7 days) cost 1.0 slot each.
// Far-term positions (settling > 7 days) cost 0.5 slots each.
// This frees capacity for short-duration trades while still accounting for
// long-dated exposure in the portfolio cap.

interface PositionCount {
  nearTermCount: number;    // settling within 7 days
  farTermCount: number;     // settling beyond 7 days
  weightedCost: number;     // nearTerm * 1.0 + farTerm * 0.5
  totalCount: number;
}

// Edge functions run as service role and bypass RLS, so we must enforce tenant
// isolation manually on every query. Signals are system-generated (user_id=null)
// or user-owned. A strategy should only see: system signals + its own user's signals.
// NOTE: signals table does not currently have a user_id column — system strategies
// pass null here and must receive the query unmodified so the filter doesn't fail.
function applySignalTenantFilter(query: any, userId: string | null | undefined): any {
  if (userId) {
    return query.or(`user_id.eq.${userId},user_id.is.null`);
  }
  // System strategy (null user_id): no filter — signals are system-generated with no user scope
  return query;
}

// Cache risk_settings and win streak per user for one auto-trade run.
const riskSettingsCache = new Map<string, any>();
const winStreakCache = new Map<string, number>();

async function computeWinStreak(supabase: any, userId: string): Promise<number> {
  if (winStreakCache.has(userId)) return winStreakCache.get(userId)!;
  const { data } = await supabase
    .from("trades")
    .select("settled_at, pnl")
    .eq("user_id", userId)
    .eq("status", "settled")
    .order("settled_at", { ascending: false })
    .limit(200);
  if (!data || data.length === 0) { winStreakCache.set(userId, 0); return 0; }
  const byDay: Record<string, number> = {};
  for (const t of data) {
    const day = (t.settled_at ?? "").slice(0, 10);
    if (day) byDay[day] = (byDay[day] ?? 0) + (t.pnl ?? 0);
  }
  const days = Object.keys(byDay).sort().reverse();
  const lastDay = new Date(days[0] + "T12:00:00Z");
  const nowNoon = new Date();
  nowNoon.setUTCHours(12, 0, 0, 0);
  const daysSinceLast = Math.floor((nowNoon.getTime() - lastDay.getTime()) / 86_400_000);
  if (daysSinceLast > 1) {
    // No positive traction in the last 24h — streak is broken
    winStreakCache.set(userId, 0);
    return 0;
  }
  let streak = 0;
  const cursor = new Date(days[0] + "T12:00:00Z");
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (!byDay[key] || byDay[key] <= 0) break;
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  winStreakCache.set(userId, streak);
  return streak;
}
async function fetchUserRiskSettings(supabase: any, userId: string): Promise<any> {
  if (riskSettingsCache.has(userId)) return riskSettingsCache.get(userId);
  const { data } = await supabase.from("risk_settings").select("*")
    .eq("user_id", userId).maybeSingle();
  const settings = data ?? { max_open_positions: 10, max_position_size: 500, max_daily_loss: 500, max_drawdown_pct: 20 };
  riskSettingsCache.set(userId, settings);
  return settings;
}

async function countOpenPositions(
  supabase: any,
  strategyId?: string,
  thresholdDays: number = 7,
  userId?: string | null,
): Promise<PositionCount> {
  const cutoff = new Date(Date.now() + thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // Prefer stored expiration_time; fall back to ticker parsing for older trades
  let query = supabase
    .from("trades")
    .select("ticker, expiration_time, strategy_id")
    .eq("status", "filled")
    .is("exit_reason", null)
    .is("settled_at", null);

  if (strategyId) {
    query = query.eq("strategy_id", strategyId);
  }

  // Scope to the correct tenant — null user_id means legacy/system strategies
  if (userId !== undefined) {
    query = userId ? query.eq("user_id", userId) : query.is("user_id", null);
  }

  const { data: openTrades } = await query;

  if (!openTrades || openTrades.length === 0) {
    return { nearTermCount: 0, farTermCount: 0, weightedCost: 0, totalCount: 0 };
  }

  let nearTermCount = 0;
  let farTermCount = 0;

  for (const trade of openTrades) {
    let settlementDate: Date | null = null;

    // Use stored expiration_time if available
    if (trade.expiration_time) {
      settlementDate = new Date(trade.expiration_time);
    } else {
      // Fall back to ticker parsing for legacy trades
      settlementDate = parseSettlementDate(trade.ticker);
    }

    if (!settlementDate) {
      // Unparseable tickers default to far-term (conservative)
      farTermCount++;
      continue;
    }

    if (settlementDate.toISOString() <= cutoff) {
      nearTermCount++;
    } else {
      farTermCount++;
    }
  }

  return {
    nearTermCount,
    farTermCount,
    weightedCost: nearTermCount * 1.0 + farTermCount * 0.5,
    totalCount: nearTermCount + farTermCount,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

// ── Kalshi HTTP wrapper with single retry + circuit breaker ─────────────────
// One retry (not three) keeps worst-case overhead at ~5s for 10 calls — safe
// under the 60s edge function timeout. Three retries × 10 calls = ~70s overhead.
async function kalshiFetch(
  url: string,
  options: RequestInit,
  circuit: { failures: number; open: boolean }
): Promise<Response> {
  if (circuit.open) throw new Error("kalshi_circuit_open");

  // Enforce minimum spacing between Kalshi requests — 100ms = 10 req/sec max
  const now = Date.now();
  const elapsed = now - lastKalshiRequestMs;
  if (elapsed < MIN_KALSHI_REQUEST_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_KALSHI_REQUEST_SPACING_MS - elapsed));
  }
  lastKalshiRequestMs = Date.now();

  const attempt = () => fetch(url, options);
  const res = await attempt();
  if (res.status === 429 || res.status >= 500) {
    const retryAfterMs = parseInt(res.headers.get("Retry-After") ?? "0", 10) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(retryAfterMs, KALSHI_RETRY_DELAY_MS)));
    lastKalshiRequestMs = Date.now();
    return attempt();
  }
  return res;
}

async function tripCircuitBreaker(supabase: any, runId: string): Promise<void> {
  const msg = `[TradeAgent] Kalshi circuit breaker tripped — ${CIRCUIT_TRIP_THRESHOLD} consecutive API failures in run ${runId}. All Kalshi requests halted for this and subsequent runs for 10 minutes.`;
  await supabase.from("compliance_log").insert({
    event_type: "kalshi_circuit_open",
    severity: "critical",
    message: msg,
    metadata: { run_id: runId, tripped_at: new Date().toISOString(), auto_reset_after: "10m" },
  }).then(() => {}).catch(() => {});
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (botToken && chatId) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    }).catch(() => {});
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // ANON_JWT is the classic JWT-format anon key stored as an explicit secret.
  // The auto-injected SUPABASE_ANON_KEY may be the new sb_publishable_ format which
  // is not a valid Bearer JWT and gets rejected by the edge function gateway.
  // Used exclusively for Authorization: Bearer on function-to-function HTTP calls.
  const supabaseAnonKey = Deno.env.get("ANON_JWT") || Deno.env.get("SUPABASE_ANON_KEY") || supabaseKey;
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const runId = crypto.randomUUID();
  const runStartedAt = new Date().toISOString();
  langfuseIngest([traceEvent(runId, "auto-trade")]);

  let lockAcquired = false; // function-scoped so finally block can access it

  try {
    // ── Atomic table-based lock ─────────────────────────────────────────────
    // Uses INSERT (not SELECT+UPSERT) so lock acquisition is a single atomic
    // statement. Two concurrent invocations both attempt INSERT — Postgres
    // unique constraint ensures only one succeeds. The losing invocation gets
    // a 23505 unique-violation error and exits. This eliminates the TOCTOU
    // race in the old SELECT→UPSERT pattern.
    //
    // Stale lock (>LOCK_STALE_MS) is cleaned up with DELETE before re-inserting.
    // Graceful fallback: if the table doesn't exist, proceed without locking.

    try {
      const now = new Date().toISOString();

      // Attempt atomic INSERT — fails with 23505 if lock exists and is fresh
      const { error: insertError } = await supabase
        .from("auto_trade_locks")
        .insert({ lock_name: "auto_trade", acquired_at: now, run_id: runId });

      if (!insertError) {
        lockAcquired = true;
      } else if (insertError.code === "23505") {
        // Another run holds the lock — check if it's stale
        const { data: existingLock } = await supabase
          .from("auto_trade_locks")
          .select("acquired_at, run_id")
          .eq("lock_name", "auto_trade")
          .maybeSingle();

        if (existingLock) {
          const lockAgeMs = Date.now() - new Date(existingLock.acquired_at).getTime();
          if (lockAgeMs < LOCK_STALE_MS) {
            const ageMin = (lockAgeMs / 60_000).toFixed(1);
            return new Response(JSON.stringify({
              skipped: true,
              reason: `Locked by run ${existingLock.run_id?.slice(0, 8)} (${ageMin}m ago)`,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          // Stale lock — delete and re-acquire
          await supabase.from("auto_trade_locks").delete().eq("lock_name", "auto_trade");
          const { error: retryError } = await supabase
            .from("auto_trade_locks")
            .insert({ lock_name: "auto_trade", acquired_at: new Date().toISOString(), run_id: runId });
          if (!retryError) lockAcquired = true;
        }
      } else if (insertError.message?.includes("Could not find") || insertError.message?.includes("does not exist")) {
        console.warn("auto_trade_locks table not found — running without lock. Apply v2 migration to enable.");
      } else {
        console.warn("auto_trade_locks insert error:", insertError.message);
      }
    } catch (lockErr) {
      console.warn("auto_trade_locks error — running without lock:", lockErr instanceof Error ? lockErr.message : String(lockErr));
    }

    // ── Check global risk state ──────────────────────────────────────────────
    const today = new Date().toISOString().split("T")[0];
    const { data: riskState } = await supabase
      .from("risk_state")
      .select("is_trading_halted, halt_reason, daily_pnl, daily_trades")
      .eq("date", today)
      .maybeSingle();

    if (riskState?.is_trading_halted) {
      await supabase.from("compliance_log").insert({
        event_type: "auto_trade_skipped",
        severity: "warning",
        message: `Auto-trade skipped: trading halted. Reason: ${riskState.halt_reason || "unknown"}`,
        metadata: { run_id: runId },
      });
      return new Response(JSON.stringify({
        skipped: true,
        reason: `Trading halted: ${riskState.halt_reason || "daily limits exceeded"}`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Cross-run Kalshi circuit breaker check ────────────────────────────────
    // If the circuit was tripped in the last 10 min, skip this run immediately.
    // Prevents stacking failed Kalshi requests during an outage across 30s cron ticks.
    // Circuit auto-resets when no new kalshi_circuit_open events appear within the window.
    const kalshiCircuit = { failures: 0, open: false };
    {
      const circuitOpenSince = new Date(Date.now() - CIRCUIT_WINDOW_MS).toISOString();
      const { data: circuitEvents } = await supabase
        .from("compliance_log")
        .select("id, created_at")
        .eq("event_type", "kalshi_circuit_open")
        .gte("created_at", circuitOpenSince)
        .limit(1);
      if (circuitEvents && circuitEvents.length > 0) {
        kalshiCircuit.open = true;
        await supabase.from("compliance_log").insert({
          event_type: "auto_trade_skipped",
          severity: "warning",
          message: "Kalshi circuit open — run skipped. Auto-resets 10 minutes after last failure.",
          metadata: { run_id: runId, circuit_open_since: circuitEvents[0].created_at },
        });
        return new Response(JSON.stringify({ skipped: true, reason: "kalshi_circuit_open" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Load active strategies ────────────────────────────────────────────────
    // Paper strategies run for all users regardless of subscription (paper = free tier).
    // Live strategies only run for active/trialing subscribers.
    // checkEntitlement enforces the live vs paper gate per strategy below.
    const { data: activeSubscribers } = await supabase
      .from("subscriptions")
      .select("user_id, tier, status, max_trades_per_day, max_open_positions, max_position_usd, max_markets_watched")
      .in("status", ["active", "trialing"]);

    const subscriptionByUserId = new Map<string, SubscriptionRow>(
      (activeSubscribers || []).map((s: any) => [s.user_id, s as SubscriptionRow])
    );

    // Load all active user strategies. Paper users run free; live users need a subscription
    // (enforced by checkEntitlement below). System strategies (user_id=null) are legacy/demo only.
    const [{ data: systemStrategies }, { data: userStrategies }] = await Promise.all([
      supabase.from("strategies").select("id, name, description, instructions, mode, starting_balance, user_id, template_id")
        .eq("active", true).is("user_id", null).order("id"),
      supabase.from("strategies").select("id, name, description, instructions, mode, starting_balance, user_id, template_id")
        .eq("active", true).not("user_id", "is", null).order("id"),
    ]);
    const strategies = [...(systemStrategies || []), ...(userStrategies || [])];

    if (!strategies || strategies.length === 0) {
      return new Response(JSON.stringify({ skipped: true, reason: "No active strategies" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load strategy_config for all active strategies
    const { data: configs } = await supabase
      .from("strategy_config")
      .select("*")
      .in("strategy_id", strategies.map((s: any) => s.id));

    const configMap = new Map<string, StrategyConfig>(
      (configs || []).map((c: StrategyConfig) => [c.strategy_id, c])
    );

    // ── Resolve AI config ─────────────────────────────────────────────────────
    const aiConfig = await resolveAiConfig(supabase);
    if (!aiConfig) {
      await supabase.from("compliance_log").insert({
        event_type: "auto_trade_skipped",
        severity: "error",
        message: "Auto-trade skipped: no AI API key configured",
        metadata: { run_id: runId },
      });
      return new Response(JSON.stringify({ skipped: true, reason: "No AI API key configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Run each active strategy deterministically ───────────────────────────
    const strategyResults: StrategyResult[] = [];

    for (const strategy of strategies) {
      const config = configMap.get(strategy.id);
      const stratStart = Date.now();

      // Check per-strategy kill switch
      if (config?.is_halted) {
        strategyResults.push({
          strategy_id: strategy.id,
          strategy_name: strategy.name,
          mode: strategy.mode,
          status: "halted",
          details: config.halt_reason || "strategy halted",
        });
        await supabase.from("compliance_log").insert({
          event_type: "auto_trade_strategy_halted",
          severity: "warning",
          message: `Strategy "${strategy.name}" (${strategy.id}) is halted: ${config.halt_reason || "unknown"}`,
          metadata: { run_id: runId, strategy_id: strategy.id },
        });
        continue;
      }

      try {
        // ── Per-strategy entitlement check ────────────────────────────────────
        // System strategies (user_id = null) bypass subscription checks.
        // User strategies must pass checkEntitlement for their tier.
        if (strategy.user_id) {
          const sub = subscriptionByUserId.get(strategy.user_id) ?? null;
          const entitlement = checkEntitlement({
            subscription: sub,
            strategy: (strategy as any).template_id ?? strategy.id,
            mode: strategy.mode as "paper" | "live",
          });
          if (!entitlement.allowed) {
            strategyResults.push({
              strategy_id: strategy.id,
              strategy_name: strategy.name,
              mode: strategy.mode,
              status: "skipped",
              details: `entitlement blocked: ${entitlement.reason}`,
            });
            continue;
          }
        }

        // ── Global risk gates from user's risk_settings ───────────────────────
        // Both checks run pre-flight so no execute-trade calls fire when a limit is reached.
        // max_open_positions: concurrent position cap (weighted by near/far term)
        // max_daily_trades:   total trades placed today across ALL strategies for this user
        let userRisk: any = null;
        let winStreak = 0;
        if (strategy.user_id) {
          userRisk = await fetchUserRiskSettings(supabase, strategy.user_id);
          winStreak = await computeWinStreak(supabase, strategy.user_id);

          // Open position cap
          const openPositions = await countOpenPositions(supabase, undefined, 7, strategy.user_id);
          if (openPositions.totalCount >= userRisk.max_open_positions) {
            await supabase.from("compliance_log").insert({
              event_type: "risk_check_failed",
              severity: "warning",
              message: `Strategy ${strategy.id} skipped: max_open_positions (${userRisk.max_open_positions}) reached — currently ${openPositions.totalCount} open`,
              metadata: { strategy_id: strategy.id, open: openPositions.totalCount, limit: userRisk.max_open_positions },
              user_id: strategy.user_id,
            });
            strategyResults.push({
              strategy_id: strategy.id,
              strategy_name: strategy.name,
              mode: strategy.mode,
              status: "skipped",
              action: "risk_blocked",
              details: `max_open_positions (${userRisk.max_open_positions}) reached — ${openPositions.totalCount} open`,
            });
            continue;
          }

          // Global daily trade cap (set via Risk tab — allocates across all strategies)
          const maxDailyTrades = userRisk.max_daily_trades ?? 30;
          const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { count: dailyTradeCount } = await supabase
            .from("trades")
            .select("id", { count: "exact", head: true })
            .eq("user_id", strategy.user_id)
            .gte("created_at", dayAgo);

          if ((dailyTradeCount ?? 0) >= maxDailyTrades) {
            strategyResults.push({
              strategy_id: strategy.id,
              strategy_name: strategy.name,
              mode: strategy.mode,
              status: "skipped",
              action: "risk_blocked",
              details: `Global daily trade cap reached: ${dailyTradeCount}/${maxDailyTrades} trades today (set in Risk Controls)`,
            });
            continue;
          }
        }

        let result: StrategyResult;
        // Route by template_id (user strategies) with fallback to id (system strategies).
        const templateId = (strategy as any).template_id ?? strategy.id;

        if (templateId === "S-001") {
          result = await runS001SurfaceArb(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId, kalshiCircuit);
        } else if (templateId === "S-002") {
          result = await runS002LongshotBias(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId, userRisk, winStreak);
        } else if (templateId === "S-005") {
          result = await runS005WeatherEdge(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId, userRisk, winStreak);
        } else {
          // Unknown strategy — hard reject. All strategies require an explicit handler.
          // This prevents a bad strategy_config row from triggering unguarded LLM usage.
          console.warn(`[auto-trade] Unknown strategy ID: ${strategy.id} — skipping. Add an explicit handler to deploy.`);
          await supabase.from("compliance_log").insert({
            event_type: "unknown_strategy_skipped",
            severity: "warning",
            message: `Strategy ${strategy.id} has no handler — skipped`,
            metadata: { strategy_id: strategy.id },
          });
          result = {
            strategy_id: strategy.id,
            strategy_name: strategy.name,
            mode: strategy.mode || "paper",
            status: "skipped",
            action: "no_handler",
            details: `Unknown strategy ID — not in allowlist (S-001, S-002, S-005). Add explicit handler to deploy.`,
          };
        }

        result.elapsed_seconds = ((Date.now() - stratStart) / 1000).toFixed(1);
        strategyResults.push(result);

        // ── Reset kill switch on success ──────────────────────────────────────
        if (config && result.action !== "no_setup" && result.status === "completed") {
          await supabase.from("strategy_config")
            .update({ consecutive_failures: 0, updated_at: new Date().toISOString() })
            .eq("strategy_id", strategy.id);
        }

        await supabase.from("compliance_log").insert({
          event_type: "auto_trade_strategy_run",
          severity: "info",
          message: `Strategy "${strategy.name}": ${result.action || result.status}${result.details ? ` — ${result.details}` : ""}`,
          metadata: { run_id: runId, ...result },
        });

      } catch (stratErr) {
        const errMsg = stratErr instanceof Error ? stratErr.message : "Unknown error";
        const elapsed = ((Date.now() - stratStart) / 1000).toFixed(1);

        captureException(stratErr, {
          function: "auto-trade",
          strategyId: strategy.id,
          runId,
          mode: strategy.mode,
          extra: { strategy_name: strategy.name, elapsed_seconds: elapsed },
        });

        strategyResults.push({
          strategy_id: strategy.id,
          strategy_name: strategy.name,
          mode: strategy.mode,
          status: "error",
          error: errMsg,
          elapsed_seconds: elapsed,
        });

        // ── Increment kill switch counter ─────────────────────────────────────
        if (config) {
          const newFailures = (config.consecutive_failures || 0) + 1;
          const shouldHalt = newFailures >= (config.max_consecutive_failures || 5);

          await supabase.from("strategy_config").update({
            consecutive_failures: newFailures,
            ...(shouldHalt ? {
              is_halted: true,
              halt_reason: `Auto-halted after ${newFailures} consecutive failures. Last error: ${errMsg.slice(0, 200)}`,
            } : {}),
            updated_at: new Date().toISOString(),
          }).eq("strategy_id", strategy.id);

          if (shouldHalt) {
            await supabase.from("compliance_log").insert({
              event_type: "strategy_auto_halted",
              severity: "error",
              message: `Strategy "${strategy.name}" auto-halted after ${newFailures} consecutive failures`,
              metadata: { run_id: runId, strategy_id: strategy.id, last_error: errMsg },
            });
          }
        }

        await supabase.from("compliance_log").insert({
          event_type: "auto_trade_strategy_error",
          severity: "error",
          message: `Strategy "${strategy.name}" failed: ${errMsg}`,
          metadata: { run_id: runId, strategy_id: strategy.id, stack: stratErr instanceof Error ? stratErr.stack : undefined },
        });
      }

    }

    // ── Log overall run ───────────────────────────────────────────────────────
    const ranCount = strategyResults.filter(s => s.status === "completed").length;
    const errCount = strategyResults.filter(s => s.status === "error").length;
    const haltedCount = strategyResults.filter(s => s.status === "halted").length;
    const tradedCount = strategyResults.filter(s =>
      s.action === "basket_executed" || s.action === "trade_executed"
    ).length;

    await supabase.from("compliance_log").insert({
      event_type: "auto_trade_run",
      severity: errCount > 0 ? "warning" : "info",
      message: `Auto-trade complete: ${ranCount} ran, ${tradedCount} traded, ${errCount} errors, ${haltedCount} halted. Daily P&L: $${(riskState?.daily_pnl || 0).toFixed(2)}, trades: ${riskState?.daily_trades || 0}`,
      metadata: {
        run_id: runId,
        started_at: runStartedAt,
        completed_at: new Date().toISOString(),
        strategies: strategyResults,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      run_id: runId,
      strategies: strategyResults,
      summary: { ran: ranCount, traded: tradedCount, errors: errCount, halted: haltedCount },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("auto-trade error:", errMsg);

    try {
      await supabase.from("compliance_log").insert({
        event_type: "auto_trade_error",
        severity: "error",
        message: `Auto-trade run failed: ${errMsg}`,
        metadata: { run_id: runId },
      });
    } catch {}

    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    // Release advisory lock — only if we successfully acquired one
    if (lockAcquired) {
      await supabase.from("auto_trade_locks").delete().eq("lock_name", "auto_trade");
    }
  }
});

// ─── Strategy S-001: KXINX Surface Arbitrage ─────────────────────────────────
// Exploits bracket-sum violations in KXINX (S&P 500) markets.
//
// Edge: Kalshi KXINX brackets must sum to exactly 100¢ (exactly one range wins).
// When they sum to >100¢, all YES markets are collectively overpriced — buying NO
// on the most expensive ones is structurally profitable regardless of S&P direction.
//
// Source: surface_alerts table (written by surface-scanner cron).
// Only trades bracket_sum_violation on KXINX (100% confidence, structural edge).
// Skips ETH/BTC (confirmed money-losers) and spread anomalies (require limit orders).

const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

async function runS001SurfaceArb(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
  runId?: string,
  kalshiCircuit: { failures: number; open: boolean } = { failures: 0, open: false },
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const AMOUNT_PER_LEG = config?.min_position_usd ?? 15; // small per-leg since we take multiple
  const MAX_LEGS_PER_EVENT = 3;
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // 1. Fetch fresh, unexploited bracket-sum violation alerts.
  // Covers KXINX (S&P 500) and KXBTC — bracket markets where structural mispricing
  // is direction-agnostic. KXETH excluded (confirmed money-loser). Sports/weather excluded.
  // Prioritise by edge descending so highest-confidence violations execute first.
  const ALLOWED_PREFIXES = ["KXINX", "KXBTC"];
  const { data: rawAlerts } = await supabase
    .from("surface_alerts")
    .select("*")
    .eq("alert_type", "bracket_sum_violation")
    .eq("is_exploited", false)
    .gte("detected_at", thirtyMinAgo)
    .gte("confidence", 0.9)
    .order("expected_edge_cents", { ascending: false })
    .limit(20);

  const alerts = (rawAlerts ?? []).filter((a: any) =>
    ALLOWED_PREFIXES.some((pfx) => (a.event_ticker as string).startsWith(pfx))
  ).slice(0, 5);

  if (alerts.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: "No fresh bracket-sum violations on KXINX/KXBTC (surface-scanner must run first)",
    };
  }

  // 2. Dedup: which tickers are already open under this strategy?
  const { data: openTrades } = await supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .eq("strategy_id", strategy.id)
    .is("settled_at", null);
  const openTickers = new Set((openTrades || []).map((t: any) => t.ticker));

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const allFilled: string[] = [];
  const seenEvents = new Set<string>();

  for (const alert of alerts) {
    const eventTicker = alert.event_ticker as string;
    if (seenEvents.has(eventTicker)) continue;

    // Event-level dedup across runs: skip if we already have any open position in this event.
    // Prevents the surface scanner's 30s refresh from re-triggering new brackets on the same event.
    const alreadyInMarket = (openTrades || []).some(
      (t: any) => (t.ticker as string).startsWith(eventTicker)
    );
    if (alreadyInMarket) continue;

    seenEvents.add(eventTicker);

    // 3. Fetch all bracket markets for this event from Kalshi
    // Uses kalshiFetch for single-retry backoff + circuit breaker protection.
    let eventMarkets: any[] = [];
    try {
      const resp = await kalshiFetch(
        `${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(eventTicker)}&status=open&limit=50`,
        {},
        kalshiCircuit
      );
      if (!resp.ok) {
        kalshiCircuit.failures++;
        if (kalshiCircuit.failures >= CIRCUIT_TRIP_THRESHOLD && !kalshiCircuit.open) {
          kalshiCircuit.open = true;
          await tripCircuitBreaker(supabase, runId);
        }
        continue;
      }
      kalshiCircuit.failures = 0; // successful response — reset failure counter
      const data = await resp.json();
      eventMarkets = data?.markets || [];
    } catch (err: any) {
      if (err.message !== "kalshi_circuit_open") {
        kalshiCircuit.failures++;
        if (kalshiCircuit.failures >= CIRCUIT_TRIP_THRESHOLD && !kalshiCircuit.open) {
          kalshiCircuit.open = true;
          await tripCircuitBreaker(supabase, runId);
        }
      }
      continue;
    }

    if (eventMarkets.length === 0) continue;

    // 4. Find the most overpriced markets: highest YES ask = most overpriced relative to fair value
    // In a fair bracket, each market's YES price should reflect its true probability.
    // When bracket sums > 100¢, all are overpriced — focus on the highest-priced ones.
    // Kalshi API returns prices as *_dollars (e.g. yes_ask_dollars: 0.45 = 45¢)
    const yesAskCents = (m: any) => Math.round(parseFloat(m.yes_ask_dollars ?? m.yes_ask ?? "0") * 100);
    const tradeable = eventMarkets
      .filter((m: any) => {
        const ask = yesAskCents(m);
        return (
          ask >= 5 &&       // enough payout if NO wins
          ask <= 92 &&      // NO side at least 8¢ to pay for commission
          !openTickers.has(m.ticker)
        );
      })
      .map((m: any) => ({
        ticker: m.ticker,
        yesAsk: yesAskCents(m),
        noPrice: 100 - yesAskCents(m),
        title: m.title || m.ticker,
        closeTime: m.close_time,
      }))
      .sort((a: any, b: any) => b.yesAsk - a.yesAsk) // highest YES = most overpriced
      .slice(0, MAX_LEGS_PER_EVENT);

    if (tradeable.length === 0) continue;

    // 5. Execute NO buys on the top overpriced markets — no LLM gate needed.
    //    The arb is structural: bracket must sum to 100¢, market says it sums to >100¢.
    const legResults = await Promise.all(tradeable.map(async (leg: any) => {
      const tradeResp = await fetch(executeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: leg.ticker,
          marketId: leg.ticker,
          marketQuestion: leg.title,
          side: "no",
          action: "buy",
          price: leg.noPrice,
          amount: AMOUNT_PER_LEG,
          strategy: strategy.name,
          strategyId: strategy.id,
          orderType: "limit",
          mode,
          notes: `S-001 Surface Arb: bracket sum violation on ${eventTicker}. YES overpriced at ${leg.yesAsk}¢ (bracket sums >100¢). Buying NO @ ${leg.noPrice}¢.`,
          expectedOutcome: `NO wins if S&P does NOT land in this bracket. Structural arb, not directional.`,
          confidenceLevel: alert.confidence,
          user_id: strategy.user_id || null,
          traceId: runId,
          systemVersion: "v2",
        }),
      });
      const result = await tradeResp.json().catch(() => ({ success: false }));
      return { ticker: leg.ticker, success: result.success, price: leg.noPrice };
    }));

    const legsFilled = legResults.filter(r => r.success);
    if (legsFilled.length > 0) {
      allFilled.push(...legsFilled.map(r => `${r.ticker}@${r.price}¢`));
      // Mark alert as exploited so we don't re-trade same event this run
      await supabase
        .from("surface_alerts")
        .update({ is_exploited: true, exploited_at: new Date().toISOString() })
        .eq("id", alert.id);
    }
  }

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: allFilled.length > 0 ? "trade_executed" : "no_setup",
    details: allFilled.length > 0
      ? `S-001 Surface Arb: ${allFilled.length} legs filled — ${allFilled.join(", ")}`
      : "No fillable KXINX legs (all tickers already held or no liquid markets)",
  };
}

// ─── Strategy S-002: Longshot Bias Exploiter ─────────────────────────────────
// Exploits the favorite-longshot bias: academically verified on Kalshi data.
// YES < 12¢ contracts resolve YES only ~7% of the time (vs. 12% implied) → buy NO.
// YES > 88¢ contracts resolve YES ~93% of the time (vs. 89% implied) → buy YES.
//
// This is statistical, not predictive — edge holds on average across many trades,
// not per-trade. Requires N≥50 trades before P&L is meaningful.
//
// Source: GWU 2026-001 + Whelan papers verified on Kalshi data.

async function runS002LongshotBias(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
  runId?: string,
  userRisk?: any,
  winStreak = 0,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  // User's limit takes precedence; 12 is the strategy-level ceiling (longshot needs diversification)
  const MAX_S002_POSITIONS = Math.min(12, userRisk?.max_open_positions ?? 12);
  // 8-11¢ YES range: EV is positive here. Below 8¢, the payout ratio (win ~9¢, lose ~91¢)
  // requires >91% win rate to break even — the longshot bias (~5pp edge) isn't enough.
  // Near-cert side (>88¢) removed: buying YES at 90¢ needs >90% win rate, we can't reliably hit that.
  const AMOUNT_PER_TRADE = 20;

  // Time-based auto-exit: close NO positions expiring within 12h to stop
  // holding losers to full resolution (-91¢ each). Strategy instructions say
  // "exit if < 12h remaining" but were never enforced in code.
  const twelveHourCutoff = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const { data: expiringPositions } = await supabase
    .from("trades")
    .select("id, ticker, side, price, amount, market_question")
    .eq("status", "filled")
    .eq("strategy_id", strategy.id)
    .is("exit_reason", null)
    .is("settled_at", null)
    .not("expiration_time", "is", null)
    .lt("expiration_time", twelveHourCutoff);

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const timeExitResults: string[] = [];
  for (const pos of expiringPositions ?? []) {
    // We bought NO to open — sell NO to close (or equivalently buy YES).
    // Use a market-price sell at 1¢ above NO bid (aggressive close).
    const closeResp = await fetch(executeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: pos.ticker,
        marketId: pos.ticker,
        marketQuestion: pos.market_question || pos.ticker,
        side: pos.side || "no",
        action: "sell",
        price: 2, // aggressive: accept near-zero to guarantee fill before expiry
        amount: pos.amount || AMOUNT_PER_TRADE,
        strategy: strategy.name,
        strategyId: strategy.id,
        orderType: "limit",
        time_in_force: "day",
        mode,
        exit_reason: "time_exit_12h",
        notes: `S-002 time-based exit: position within 12h of expiry — closing to prevent full-resolution loss`,
        user_id: strategy.user_id || null,
        traceId: runId,
        systemVersion: "v2",
      }),
    });
    const closeResult = await closeResp.json().catch(() => ({ success: false }));
    timeExitResults.push(`${pos.ticker}: ${closeResult.success ? "closed" : "close_failed"}`);
  }

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // Longshots only: YES ask 8-11¢. We buy NO on these markets.
  const { data: rawSignals } = await applySignalTenantFilter(
    supabase
      .from("signals")
      .select("*")
      .lt("yes_ask", 12)
      .gte("yes_ask", 8)
      .gte("volume", 200)
      .gte("days_to_close", 0.08)
      .lte("days_to_close", 30)
      .gte("created_at", twoHoursAgo)
      .not("direction", "is", null)
      .eq("was_acted_on", false)
      .order("created_at", { ascending: false })
      .limit(20),
    strategy.user_id
  );

  // Hard block: no ETH, no sports, no weather (S-005 owns weather with a real GFS model;
  // S-002 has no weather-specific edge and will trade against S-005's positions)
  const blockedPrefixes = ["KXETH", "KXNHL", "KXNBA", "KXMLB", "KXNFL", "KXHIGH"];
  // Live close-time guard: even if days_to_close in the signal looks positive (stale),
  // reject any market whose close_time is already in the past or within 2 hours.
  // This was the root cause of the 48-position runaway on KXINX-26MAY15 — the signal
  // generator kept emitting fresh signals with stale days_to_close after market close.
  const fifteenMinFromNow = Date.now() + 15 * 60 * 1000;
  const signals = (rawSignals || []).filter((s: any) => {
    if (blockedPrefixes.some(p => (s.ticker || "").toUpperCase().startsWith(p))) return false;
    // Reject only if market is already closed or closing within 15 min — not enough
    // time for a limit order to fill. Short-duration trades (1-2h left) are valid
    // and often stronger setups for the longshot bias.
    if (s.close_time) {
      const closeMs = new Date(s.close_time).getTime();
      if (closeMs <= fifteenMinFromNow) return false;
    }
    return true;
  });

  if (signals.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: "No longshot signals (yes_ask 8-11¢, vol≥200, 2h-30d, non-sports/ETH)",
    };
  }

  // Weighted position count: near-term (≤7d) = 1.0 slot, far-term = 0.5 slot
  const positions = await countOpenPositions(supabase, "S-002", 7, strategy.user_id ?? null);
  const openS002Count = positions.weightedCost;
  const nearTermOnly = positions.nearTermCount;
  const farTermOnly = positions.farTermCount;

  if (openS002Count >= MAX_S002_POSITIONS) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `S-002 at max positions: weighted ${openS002Count.toFixed(1)}/${MAX_S002_POSITIONS} (near: ${nearTermOnly}, far: ${farTermOnly})`,
    };
  }

  const slotsAvailable = MAX_S002_POSITIONS - openS002Count;

  // Dedup: fetch open tickers to skip already-held positions.
  // Must scope by user_id to avoid cross-tenant false positives.
  let dedupQuery = supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .eq("strategy_id", strategy.id)
    .is("exit_reason", null)
    .is("settled_at", null);
  dedupQuery = strategy.user_id
    ? dedupQuery.eq("user_id", strategy.user_id)
    : dedupQuery.is("user_id", null);
  const { data: s002OpenTrades } = await dedupQuery;
  const openTickers = new Set((s002OpenTrades || []).map((t: any) => t.ticker));
  const seenTickers = new Set<string>();
  const seenEventRoots = new Set<string>();
  const candidates = signals.filter((s: any) => {
    if (openTickers.has(s.ticker)) return false;
    if (seenTickers.has(s.ticker)) return false;
    seenTickers.add(s.ticker);
    // Prevent entering two correlated thresholds on the same economic event
    // e.g. KXCHCUTS-26MAY07-T60000 and KXCHCUTS-26MAY07-T75000 → same root KXCHCUTS-26MAY07
    const eventRoot = (s.ticker || "").replace(/-[TB]\d+.*$/, "");
    if (eventRoot && seenEventRoots.has(eventRoot)) return false;
    if (eventRoot) seenEventRoots.add(eventRoot);
    return true;
  }).slice(0, Math.min(slotsAvailable, 5));

  if (candidates.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: "All longshot signals already have open positions",
    };
  }

  const execResults = await Promise.all(candidates.map(async (sig: any) => {
    const yesAsk = sig.yes_ask || 10;

    // Hard guard: re-validate price at execution time. Signals can be stale —
    // a market at 10¢ YES when the signal was written may have moved significantly.
    if (yesAsk < 8 || yesAsk > 11) {
      return { sig, success: false, detail: `skipped: yes_ask=${yesAsk}¢ out of 8-11¢ range at execution time` };
    }

    // All signals are in the 8-11¢ YES range — we always buy NO.
    const side = "no";
    const direction = "buy_no";

    // Maker order: set NO price just above NO bid (= 100 - YES ask - 1)
    // YES ask 8¢ → NO price 93¢; YES ask 11¢ → NO price 90¢
    const price = Math.min(99, (100 - yesAsk) + 1);

    const qualifyPrompt = buildQualifyPrompt("S-002 Longshot Bias", {
      ticker: sig.ticker,
      market_question: sig.market_question,
      direction,
      yes_bid: sig.yes_bid,
      yes_ask: sig.yes_ask,
      volume: sig.volume,
      days_to_close: sig.days_to_close,
      win_streak: winStreak,
      performance_context: winStreak >= 3
        ? `Agent is on a ${winStreak}-day winning streak — momentum is strong, continue qualifying sound setups.`
        : winStreak === 0
        ? "No active win streak — last closed day was not profitable or no recent settlements. Be disciplined: only QUALIFY setups with clear structural edge."
        : `Agent is on day ${winStreak} of a positive run — stay selective, protect the streak.`,
      note: `Longshot Bias (longshot-only mode): YES ask is ${yesAsk}¢, we buy NO at ~${price}¢. Academic research shows Kalshi markets in the 8-11¢ range resolve YES ~7% vs. 12% implied — we have a structural edge buying NO here. REJECT only if: market has an obvious volume pump (>10x normal), expiry in <6h, or the market question makes this specific event genuinely likely (e.g. breaking news). Do NOT reject just because the NO price is high — that is expected and correct for a longshot.`,
    });

    const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt, mode, runId, strategy.id, supabase);
    if (!qualified) return { sig, success: false, detail: `rejected: ${reason}` };

    const tradeResp = await fetch(executeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: sig.ticker,
        marketId: sig.ticker,
        marketQuestion: sig.market_question || sig.ticker,
        side,
        action: "buy",
        price: Math.round(price),
        amount: AMOUNT_PER_TRADE,
        strategy: strategy.name,
        strategyId: strategy.id,
        orderType: "limit",
        time_in_force: "day",
        mode,
        expirationTime: parseSettlementDate(sig.ticker)?.toISOString() || null,
        notes: `S-002 Longshot Bias: longshot NO, ${direction} @ ${Math.round(price)}¢ (maker day order). ${reason}`,
        expectedOutcome: `${direction} on ${sig.ticker} — bias edge ~5pp`,
        confidenceLevel: 0.55,
        user_id: strategy.user_id || null,
        traceId: runId,
        sourceSignalId: sig.id || null,
        systemVersion: 'v2',
      }),
    });

    const result = await tradeResp.json().catch(() => ({ success: false, error: "parse failed" }));
    if (!result.success) {
      const errDetail = result.error || result.message || "unknown error";
      captureMessage(`S-002 execute-trade failed: ${errDetail}`, "warning", {
        function: "auto-trade", strategyId: "S-002", runId, mode,
        extra: { ticker: sig.ticker, price, direction: "buy_no", response: result },
      });
    }
    return { sig, success: result.success, detail: result.success ? `${sig.ticker} NO @ ${Math.round(price)}¢` : (result.error || result.message || "unknown error") };
  }));

  const filled = execResults.filter(r => r.success);

  // Mark consumed signals so the next cron run skips them — without this, the same
  // signal is re-qualified on every 30s run until the freshness window expires.
  if (filled.length > 0) {
    const filledIds = filled.map(r => r.sig.id).filter(Boolean);
    if (filledIds.length > 0) {
      await supabase.from("signals")
        .update({ was_acted_on: true, acted_on_at: new Date().toISOString() })
        .in("id", filledIds)
        .eq("was_acted_on", false);
    }
  }

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: filled.length > 0 ? "trade_executed" : "no_setup",
    details: [
      filled.length > 0
        ? `Longshot Bias executed ${filled.length}/${candidates.length}: ${filled.map(r => r.detail).join(", ")}`
        : `No fills: ${execResults.map(r => r.detail).join("; ")}`,
      timeExitResults.length > 0 ? `Time exits (12h): ${timeExitResults.join(", ")}` : "",
    ].filter(Boolean).join(" | "),
  };
}

// ─── Strategy S-005: Weather Edge ────────────────────────────────────────────
// Reads signals produced by the weather-signal edge function (GFS ensemble vs
// Kalshi weather market prices) and executes when edge ≥15¢.
//
// Key improvements over v1:
//   - Edge floor raised 8¢ → 15¢ (weather is hard; need bigger cushion)
//   - City win/loss history from settled trades injected into qualify prompt
//   - LLM told to REJECT cities with ≥2 prior losses
//   - Parallelized: all signals LLM-gated simultaneously

async function runS005WeatherEdge(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
  runId?: string,
  userRisk?: any,
  winStreak = 0,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 15; // raised from 8¢ — weather needs bigger edge
  const maxPositionUsd = config?.max_position_usd ?? 30;
  const MAX_PARALLEL_SIGNALS = 5;
  const excludedCities: string[] = (config as any)?.excluded_cities ?? [];

  // 12h window: GFS model updates at ~04:00 and ~07:00 UTC, then weather-signal deduplicates
  // and skips re-insertion until the next model run. Signals are valid all trading day —
  // same-day bucket markets don't change their forecast meaningfully between model runs.
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data: rawSignals } = await applySignalTenantFilter(
    supabase
      .from("signals")
      .select("*")
      .eq("source", "weather_signal_s005")
      .gte("created_at", twelveHoursAgo)
      .gte("edge_cents", minEdge)
      .not("direction", "is", null)
      .eq("was_acted_on", false)
      .order("edge_cents", { ascending: false })
      .limit(MAX_PARALLEL_SIGNALS + excludedCities.length), // fetch extra, filter below
    null // signals are system-generated — no user_id column on signals table
  );

  // Filter out cities where S-005 has persistent forecast_bias losses
  const signals = excludedCities.length > 0
    ? (rawSignals || []).filter((s: any) => {
        const cityMatch = (s.ticker || "").match(/^KXHIGH([A-Z]{2,4})-/);
        return !cityMatch || !excludedCities.includes(cityMatch[1]);
      }).slice(0, MAX_PARALLEL_SIGNALS)
    : (rawSignals || []).slice(0, MAX_PARALLEL_SIGNALS);

  if (!signals || signals.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `No weather signals with edge >= ${minEdge}c in last 12h (GFS model updates ~04:00 and ~07:00 UTC)`,
    };
  }

  const positions = await countOpenPositions(supabase, undefined, 7, strategy.user_id ?? null);
  const maxPositions = userRisk?.max_open_positions ?? 10;
  const slotsAvailable = Math.max(0, maxPositions - positions.totalCount);
  if (slotsAvailable === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `Portfolio full: ${positions.totalCount}/${maxPositions} open positions (near: ${positions.nearTermCount}, far: ${positions.farTermCount})`,
    };
  }

  // Dedup: skip tickers already held AND skip cities already held (one leg per city per run).
  // Prevents double-exposure when both a "T73" and "B70.5" signal exist for the same city.
  const { data: openTrades } = await supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .is("exit_reason", null)
    .is("settled_at", null);
  const openTickers = new Set((openTrades || []).map((t: any) => t.ticker));
  const openCities = new Set(
    (openTrades || []).map((t: any) => {
      const m = (t.ticker || "").match(/^KXHIGH([A-Z]{2,4})-/);
      return m ? m[1] : null;
    }).filter(Boolean)
  );
  const seenCities = new Set<string>();
  const deduped = signals.filter((s: any) => {
    if (openTickers.has(s.ticker)) return false;
    const cityMatch = (s.ticker || "").match(/^KXHIGH([A-Z]{2,4})-/);
    if (cityMatch) {
      if (openCities.has(cityMatch[1])) return false;
      if (seenCities.has(cityMatch[1])) return false;
      seenCities.add(cityMatch[1]);
    }
    return true;
  });

  if (deduped.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `All ${signals.length} signal(s) already have open positions — skipping`,
    };
  }

  // 2. Pull city win/loss history from settled trades + recent lessons.
  const candidates = deduped.slice(0, slotsAvailable);
  const cityTags = [...new Set(candidates.map((s: any) => (s.metadata?.location ?? "").toLowerCase()).filter(Boolean))];
  const lessonsByCity = new Map<string, any[]>();
  const cityWinLoss = new Map<string, { wins: number; losses: number; totalPnl: number }>();

  // Bayesian agent_memory: high-confidence distilled lessons for this strategy
  const { data: strategyMemories } = await supabase
    .from("agent_memory")
    .select("title, content, confidence")
    .eq("strategy_id", strategy.id)
    .eq("is_active", true)
    .order("confidence", { ascending: false })
    .limit(5);
  const memoryBlock = (strategyMemories ?? [])
    .map((m: any) => `[confidence ${m.confidence.toFixed(2)}] ${m.title}: ${m.content}`)
    .join("\n");

  if (cityTags.length > 0) {
    // Settled trades for weather tickers to get per-city win rates
    const { data: weatherTrades } = await supabase
      .from("trades")
      .select("ticker, pnl, notes")
      .eq("status", "settled")
      .eq("strategy_id", strategy.id);

    for (const t of weatherTrades || []) {
      const pnl = Number(t.pnl) || 0;
      // Extract city from notes or ticker (notes include location from signal)
      for (const city of cityTags) {
        if ((t.notes || "").toLowerCase().includes(city) || (t.ticker || "").toLowerCase().includes(city)) {
          const stat = cityWinLoss.get(city) || { wins: 0, losses: 0, totalPnl: 0 };
          if (pnl > 0) stat.wins++;
          else if (pnl < 0) stat.losses++;
          stat.totalPnl += pnl;
          cityWinLoss.set(city, stat);
          break;
        }
      }
    }

    // Recent lessons by city tag
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: lessons } = await supabase
      .from("trade_lessons")
      .select("tags, lesson_type, lesson, do_differently, confidence, outcome")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(30);

    for (const lesson of lessons ?? []) {
      for (const city of cityTags) {
        if ((lesson.tags ?? []).includes(city)) {
          if (!lessonsByCity.has(city)) lessonsByCity.set(city, []);
          lessonsByCity.get(city)!.push(lesson);
        }
      }
    }
  }

  // 3. LLM-gate signals. High-edge signals (>= 25¢) bypass the LLM entirely — the
  //    NWS/Kalshi divergence is structural, not sentiment-driven. Same logic as S-001 arb.
  //    Low-edge signals still go through the LLM gate for discretionary review.
  const AUTO_QUALIFY_EDGE = 25;
  const autoQualified = candidates
    .filter((s: any) => (s.edge_cents ?? 0) >= AUTO_QUALIFY_EDGE)
    .map((sig: any) => ({ sig, qualified: true, reason: `auto-qualified: edge ${sig.edge_cents}¢ >= ${AUTO_QUALIFY_EDGE}¢` }));
  const needsLlm = candidates.filter((s: any) => (s.edge_cents ?? 0) < AUTO_QUALIFY_EDGE);

  const qualifyResults = needsLlm.length > 0 ? await Promise.all(
    needsLlm.map(async (sig: any) => {
      const city = (sig.metadata?.location ?? "").toLowerCase();
      const cityLessons = lessonsByCity.get(city) ?? [];
      const stat = cityWinLoss.get(city);
      const cityHistoryNote = stat
        ? `City track record: ${stat.wins}W/${stat.losses}L, total P&L $${stat.totalPnl.toFixed(2)}.${stat.losses >= 2 ? " CAUTION: multiple prior losses — REJECT unless edge is exceptionally large (>25¢)." : ""}`
        : "No prior weather trades for this city.";
      const lessonBlock = cityLessons.length > 0
        ? cityLessons.slice(0, 3).map((l: any) =>
            `[${l.lesson_type}/${l.outcome}] ${l.lesson} → ${l.do_differently}`
          ).join("\n")
        : "";

      const prompt = buildQualifyPrompt("S-005 Weather Edge", {
        ticker: sig.ticker,
        market_question: sig.market_question,
        direction: sig.direction,
        edge_cents: sig.edge_cents,
        true_probability: sig.true_probability,
        implied_probability: sig.implied_probability,
        yes_bid: sig.yes_bid,
        yes_ask: sig.yes_ask,
        forecast_expected_high: sig.metadata?.forecast_expected_high,
        forecast_std_dev: sig.metadata?.forecast_std_dev,
        location: sig.metadata?.location,
        city_history: cityHistoryNote,
        win_streak: winStreak,
        performance_context: winStreak >= 3
          ? `Agent is on a ${winStreak}-day winning streak — momentum is strong, continue qualifying sound setups.`
          : winStreak === 0
          ? "No active win streak — last closed day was not profitable or no recent settlements. Be disciplined: only QUALIFY setups with clear structural edge."
          : `Agent is on day ${winStreak} of a positive run — stay selective, protect the streak.`,
        ...(lessonBlock ? { past_lessons: lessonBlock } : {}),
        ...(memoryBlock ? { strategy_memory: memoryBlock } : {}),
        note: `Weather Edge: GFS ensemble forecast vs Kalshi price. Mode: ${mode.toUpperCase()} — ${mode === "paper" ? "LEAN QUALIFY to collect data. QUALIFY whenever edge_cents >= 5 and data is fresh. Large divergences (e.g., true_prob=2% vs implied=60%) are EXPECTED and correct — that IS the edge." : "require edge >= 15¢."}. REJECT ONLY if: market expires in < 2h, city in ticker does not match location, or data is clearly corrupt (null prices). Do NOT reject based on the size of the divergence — large divergence is the signal.`,
      });
      const { qualified, reason } = await qualifySetup(aiConfig, prompt, mode, runId, strategy.id, supabase);
      return { sig, qualified, reason };
    })
  ) : [];

  const qualifiedList = [...autoQualified, ...qualifyResults.filter(r => r.qualified)];
  if (qualifiedList.length === 0) {
    const reasons = qualifyResults.map(r => `${r.sig.ticker}: ${r.reason}`).join("; ");
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `All signals rejected by LLM safety gate. ${reasons}`,
    };
  }

  // 3. Execute all qualified trades in parallel
  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const execResults = await Promise.all(
    qualifiedList.map(async ({ sig, reason }) => {
      const side = sig.direction === "buy_yes" ? "yes" : "no";
      // MAKER orders: rest inside the spread at bid+1¢ (was taker at ask)
      const price = sig.direction === "buy_yes"
        ? Math.max(1, (sig.yes_bid || 50) + 1)
        : Math.max(1, (100 - (sig.yes_ask || 50)) + 1);
      // Tiered sizing: scale position by edge magnitude.
      // Larger edge = more confident GFS divergence = bigger bet, capped at maxPositionUsd.
      const edgeCents = sig.edge_cents ?? 0;
      const amount = edgeCents >= 35
        ? maxPositionUsd                          // high-conviction: full size ($20)
        : edgeCents >= 20
          ? Math.round(maxPositionUsd * 0.65)    // medium: 65% ($13)
          : Math.round(maxPositionUsd * 0.40);   // threshold-level: 40% ($8)

      const tradeResp = await fetch(executeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: sig.ticker,
          marketId: sig.ticker,
          marketQuestion: sig.market_question || sig.ticker,
          side,
          action: "buy",
          price: Math.round(price),
          amount,
          strategy: strategy.name,
          strategyId: strategy.id,
          orderType: "limit",
          mode,
          expirationTime: parseSettlementDate(sig.ticker)?.toISOString() || null,
          notes: `S-005 auto-trade: edge=${sig.edge_cents}c, true_p=${sig.true_probability}, maker order at bid+1¢. ${reason}`,
          expectedOutcome: `NWS model: ${sig.direction} (true_p=${sig.true_probability}, implied_p=${sig.implied_probability})`,
          confidenceLevel: sig.true_probability,
          user_id: strategy.user_id || null,
          traceId: runId,
          sourceSignalId: sig.id || null,
          systemVersion: 'v2',
        }),
      });
      const result = await tradeResp.json().catch(() => ({ success: false, error: "parse failed" }));
      return { sig, side, price, amount, result };
    })
  );

  const filled = execResults.filter(r => r.result.success);
  const failed = execResults.filter(r => !r.result.success);

  // Mark consumed signals so the next cron run skips them — without this, the same
  // weather signal is re-qualified on every 30s run for its full 12h freshness window.
  if (filled.length > 0) {
    const filledIds = filled.map(r => r.sig.id).filter(Boolean);
    if (filledIds.length > 0) {
      await supabase.from("signals")
        .update({ was_acted_on: true, acted_on_at: new Date().toISOString() })
        .in("id", filledIds)
        .eq("was_acted_on", false);
    }
  }

  const detailParts = [
    filled.length > 0
      ? `Executed ${filled.length} trade(s): ${filled.map(r => `${r.sig.ticker} ${r.sig.edge_cents}c edge`).join(", ")}`
      : null,
    failed.length > 0
      ? `${failed.length} failed: ${failed.map(r => r.result.error || r.result.message || "unknown").join(", ")}`
      : null,
  ].filter(Boolean).join(". ");

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: filled.length > 0 ? "trade_executed" : "no_setup",
    details: detailParts || "No trades executed",
  };
}

// ─── Generic Signal Strategy ──────────────────────────────────────────────────
// Fallback for strategies not mapped to S-001/004.
// Uses the LLM more broadly but still filters signals server-side first.

// ─── Shared Helpers ───────────────────────────────────────────────────────────

/**
 * Kelly criterion position sizing with quarter-Kelly fraction cap.
 * Returns dollar amount, floored at $10, capped at $100.
 */
function kellySize(trueP: number, marketP: number, bankroll: number, fraction = 0.25): number {
  if (trueP <= 0 || trueP >= 1 || marketP <= 0 || marketP >= 1) return 20;
  const b = (1 - marketP) / marketP;
  const q = 1 - trueP;
  const f = (b * trueP - q) / b;
  if (f <= 0) return 10;
  return Math.max(10, Math.min(100, Math.round(bankroll * f * fraction)));
}

/**
 * Build a focused qualify/reject prompt for the LLM.
 * Returns exactly one decision: QUALIFY or REJECT + one-sentence reason.
 */
function buildQualifyPrompt(strategyName: string, context: Record<string, any>, lessons: string[] = []): string {
  const ctx = Object.entries(context)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const lessonsSection = lessons.length > 0
    ? `\nRecent losses from this strategy — patterns to avoid repeating:\n${lessons.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n`
    : "";

  return `You are a trading judge for the "${strategyName}" strategy on Kalshi prediction markets.

Review this specific setup and decide: QUALIFY or REJECT.

Setup details:
${ctx}
${lessonsSection}
Rules for QUALIFY:
- The opportunity is genuine and matches the strategy's intent
- Market is liquid enough to fill at the given price
- The edge is real, not noise
- No obvious reason the market is mispriced in the other direction

Rules for REJECT:
- Edge looks like noise or stale data
- Market has very low activity or closing imminently with no edge
- Position would be correlated with existing risk
- Setup matches a known losing pattern from recent history
- Any other strong reason to skip

Respond in exactly this format:
QUALIFY
Reason: [one sentence explaining why this qualifies]

OR:

REJECT
Reason: [one sentence explaining why this is rejected]`;
}

async function fetchStrategyLessons(supabase: any, strategyId: string): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("trade_lessons")
      .select("lesson, do_differently, outcome")
      .eq("strategy_id", strategyId)
      .eq("outcome", "loss")
      .order("created_at", { ascending: false })
      .limit(5);
    return (data || []).map((r: any) => `${r.lesson} → ${r.do_differently}`);
  } catch {
    return [];
  }
}

/**
 * Call the AI API with a qualify/reject prompt.
 * Returns { qualified: boolean, reason: string }.
 *
 * Pass mode="paper" to bypass the LLM entirely — paper trading is for data
 * collection; every numerically-filtered signal should be executed so we
 * accumulate outcome data as fast as possible.
 */
async function qualifySetup(
  aiConfig: AiConfig,
  prompt: string,
  mode = "paper",
  traceId?: string,
  strategyId?: string,
  supabaseClient?: any,
): Promise<{ qualified: boolean; reason: string }> {
  // Paper mode uses the same LLM gate as live — training must mirror production.
  // No bypass here; the only difference between paper and live is whether
  // execute-trade submits a real Kalshi order or simulates one.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), QUALIFY_TIMEOUT_MS);
  const startTime = new Date().toISOString();

  try {
    const resp = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${aiConfig.apiKey}`,
        "Content-Type": "application/json",
        ...(aiConfig.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
        ...(aiConfig.provider === "openrouter" ? { "HTTP-Referer": "https://omii-ai-pm-trade-agent.vercel.app" } : {}),
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      if (resp.status === 429 && supabaseClient) {
        supabaseClient.from("compliance_log").insert({
          event_type: "llm_rate_limit",
          severity: "error",
          message: `LLM rate limit hit (429) from ${aiConfig.provider} for strategy ${strategyId ?? "unknown"}`,
          metadata: {
            provider: aiConfig.provider,
            model: aiConfig.model,
            strategy_id: strategyId,
            retry_after: resp.headers.get("retry-after"),
          },
        }).then().catch(() => {});
      }
      return { qualified: false, reason: `AI API error: ${resp.status}` };
    }

    const data = await resp.json();
    const endTime = new Date().toISOString();
    const text = (data?.choices?.[0]?.message?.content || "").trim();
    const upper = text.toUpperCase();
    const qualified = upper.startsWith("QUALIFY");

    // Extract reason line
    const reasonMatch = text.match(/Reason:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : text.slice(0, 150);

    if (traceId) {
      langfuseIngest([generationEvent({
        traceId,
        name: `qualify-${strategyId ?? "unknown"}`,
        model: aiConfig.model,
        prompt,
        completion: text,
        startTime,
        endTime,
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
        metadata: { qualified, reason, mode, strategyId },
      })]);
    }

    // Log actual token usage to compliance_log so the dashboard can compute real costs.
    // This is the source of truth — prompt_tokens / completion_tokens come directly from the API response.
    if (supabaseClient && data?.usage) {
      supabaseClient.from("compliance_log").insert({
        event_type: "llm_usage",
        severity: "info",
        message: `qualify: ${data.usage.prompt_tokens ?? "?"} in / ${data.usage.completion_tokens ?? "?"} out · ${qualified ? "QUALIFY" : "REJECT"}`,
        metadata: {
          model: aiConfig.model,
          provider: aiConfig.provider,
          prompt_tokens: data.usage.prompt_tokens ?? null,
          completion_tokens: data.usage.completion_tokens ?? null,
          total_tokens: data.usage.total_tokens ?? null,
          qualified,
          strategy_id: strategyId ?? null,
        },
      });
    }

    return { qualified, reason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const isTimeout = err instanceof Error && (err.name === "AbortError" || /timeout/i.test(err.message));
    if (supabaseClient) {
      supabaseClient.from("compliance_log").insert({
        event_type: isTimeout ? "api_timeout" : "auto_trade_strategy_error",
        severity: isTimeout ? "warning" : "error",
        message: isTimeout
          ? `LLM qualify call timed out after ${QUALIFY_TIMEOUT_MS}ms for strategy ${strategyId ?? "unknown"}`
          : `LLM qualify call failed for strategy ${strategyId ?? "unknown"}: ${msg}`,
        metadata: {
          provider: aiConfig.provider,
          model: aiConfig.model,
          strategy_id: strategyId,
          timeout_ms: QUALIFY_TIMEOUT_MS,
          error_name: err instanceof Error ? err.name : "unknown",
        },
      }).then().catch(() => {});
    }
    return { qualified: false, reason: `qualify call failed: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check current open positions count and total USD exposure.
 */
// Legacy compatibility — delegates to countOpenPositions with weighted aging.
// Returns openCount (raw total) and totalUsd (capital at risk).
async function checkPortfolioExposure(supabase: any): Promise<{ openCount: number; totalUsd: number }> {
  const { data: open } = await supabase
    .from("trades")
    .select("amount, price")
    .eq("status", "filled")
    .is("exit_reason", null)
    .is("settled_at", null);

  const openCount = (open || []).length;
  const totalUsd = (open || []).reduce((sum: number, t: any) => {
    return sum + ((t.amount || 0) * (t.price || 0)) / 100;
  }, 0);

  return { openCount, totalUsd };
}

/**
 * Resolve the best available AI config from DB api_keys or env vars.
 * Priority: OpenRouter → Anthropic → OpenAI → Google
 * Handles both legacy plaintext and AES-GCM encrypted secrets (EncryptedSecret JSON).
 */
async function resolveAiConfig(supabase: any): Promise<AiConfig | null> {
  // Check saved model preference
  const { data: savedModel } = await supabase
    .from("api_keys")
    .select("key_id")
    .eq("provider", "model_agent")
    .maybeSingle();

  const preferredModel = savedModel?.key_id;

  // Load available keys (encrypted_secret may be plaintext or EncryptedSecret JSON)
  const { data: keyRows } = await supabase
    .from("api_keys")
    .select("provider, encrypted_secret")
    .in("provider", ["openrouter", "anthropic", "openai", "google"]);

  // Decrypt a stored secret if it looks like a JSON EncryptedSecret object.
  // Falls back to using the raw value for legacy plaintext rows.
  async function resolveKey(raw: string | null | undefined): Promise<string | undefined> {
    if (!raw) return undefined;
    // Try parsing as EncryptedSecret JSON — legacy plaintext is never valid JSON
    try {
      const parsed = JSON.parse(raw) as EncryptedSecret;
      if (parsed?.ciphertext && parsed?.iv) {
        const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
        if (!masterKeyBase64) {
          console.error("resolveAiConfig: API_KEY_ENCRYPTION_KEY not set — cannot decrypt stored API key");
          return undefined;
        }
        const masterKey = await importMasterKey(masterKeyBase64);
        return await decryptSecret(parsed, masterKey);
      }
    } catch {
      // Not JSON — treat as legacy plaintext
    }
    return raw;
  }

  const rawMap = new Map((keyRows || []).map((r: any) => [r.provider, r.encrypted_secret as string | null]));

  const openrouterKey = await resolveKey(rawMap.get("openrouter")) ?? Deno.env.get("OPENROUTER_API_KEY");
  const anthropicKey = await resolveKey(rawMap.get("anthropic")) ?? Deno.env.get("ANTHROPIC_API_KEY");
  const openaiKey = await resolveKey(rawMap.get("openai")) ?? Deno.env.get("OPENAI_API_KEY");

  if (openrouterKey) {
    return {
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: preferredModel || "openai/gpt-4o-mini",
      provider: "openrouter",
    };
  }
  if (anthropicKey && (preferredModel?.startsWith("claude-") || preferredModel?.startsWith("anthropic/"))) {
    const modelId = preferredModel.startsWith("anthropic/")
      ? preferredModel.replace("anthropic/", "")
      : preferredModel;
    return {
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: modelId,
      provider: "anthropic",
    };
  }
  if (anthropicKey && !openaiKey) {
    // Anthropic key present but no Claude model selected and no OpenAI key — no usable config
    return null;
  }
  if (openaiKey) {
    return {
      apiKey: openaiKey,
      baseUrl: "https://api.openai.com/v1",
      model: preferredModel || "gpt-4o-mini",
      provider: "openai",
    };
  }

  return null;
}

/**
 * Construct basket legs from a surface_alert.
 * Handles monotonicity and bracket sum violation structures.
 */
function buildArbLegs(alert: any, contractSize: number): any[] | null {
  // Monotonicity violation: ticker_a = lower threshold (YES underpriced → buy YES),
  //                         ticker_b = higher threshold (YES overpriced → buy NO).
  // Bracket sum / spread anomaly: only ticker_a is set; ticker_b is null.
  if (!alert.ticker_a) return null;

  // Prices come from price_a_cents / price_b_cents (surface-scanner column names).
  const priceA = alert.price_a_cents || 50;
  const priceB = alert.price_b_cents || 50;

  // Sides: for monotonicity, buy the cheap YES (A) and the cheap NO (B).
  // For all other types, both are YES buys.
  const sideA: string = "yes";
  const sideB: string = alert.alert_type === "monotonicity_violation" ? "no" : "yes";

  const legs: any[] = [
    {
      ticker: alert.ticker_a,
      side: sideA,
      action: "buy",
      price: priceA,
      amount: Math.max(1, Math.floor((contractSize * 100) / priceA)),
      market_question: alert.ticker_a,
      order_type: "limit",
    },
  ];

  // Only add the second leg when ticker_b exists (monotonicity violations have both).
  if (alert.ticker_b) {
    legs.push({
      ticker: alert.ticker_b,
      side: sideB,
      action: "buy",
      price: priceB,
      amount: Math.max(1, Math.floor((contractSize * 100) / priceB)),
      market_question: alert.ticker_b,
      order_type: "limit",
    });
  }

  // Validate prices are in valid Kalshi range (1–99¢)
  if (legs.some(l => l.price < 1 || l.price > 99)) return null;

  return legs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
