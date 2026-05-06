import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { langfuseIngest, traceEvent, generationEvent } from "../_shared/langfuse.ts";
import { captureException, captureMessage } from "../_shared/sentry.ts";

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

async function countOpenPositions(
  supabase: any,
  strategyId?: string,
  thresholdDays: number = 7,
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

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // For function-to-function calls (execute-trade), use the anon key with apikey header.
  // The service role JWT is rejected by the Supabase runtime when used as Bearer for
  // edge function invocations — the anon key is what pg_cron uses and what works.
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || supabaseKey;
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
    // ── Advisory lock: skip if another run is in progress ───────────────────
    // Table-based lock (not pg_try_advisory_lock) because Supabase pgbouncer
    // gives each edge function invocation a different DB session. A table with
    // single-row upsert is atomic and survives connection pooling.
    // Graceful fallback: if the lock table doesn't exist yet (migration pending),
    // proceed without locking — the old debounce behavior.

    try {
      const { data: existingLock, error: selectError } = await supabase
        .from("auto_trade_locks")
        .select("*")
        .eq("lock_name", "auto_trade")
        .maybeSingle();

      // If the table doesn't exist yet, fall through to proceed without locking
      if (selectError && selectError.message.includes("Could not find")) {
        console.warn("auto_trade_locks table not found — running without advisory lock. Run the v2 migration to enable 30s polling protection.");
      } else if (selectError) {
        console.warn("auto_trade_locks select error:", selectError.message);
      } else if (existingLock) {
        const lockAgeMs = Date.now() - new Date(existingLock.acquired_at).getTime();
        if (lockAgeMs < LOCK_STALE_MS) {
          const ageMin = (lockAgeMs / 60_000).toFixed(1);
          return new Response(JSON.stringify({
            skipped: true,
            reason: `Locked by run ${existingLock.run_id.slice(0, 8)} (${ageMin}m ago)`,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Stale lock — proceed and overwrite below
      }

      // Atomic lock acquisition via upsert (skip if table doesn't exist)
      if (!selectError || !selectError.message.includes("Could not find")) {
        const { error: lockError } = await supabase
          .from("auto_trade_locks")
          .upsert({ lock_name: "auto_trade", acquired_at: new Date().toISOString(), run_id: runId }, { onConflict: "lock_name" });

        if (lockError) {
          // Table might have been created between checks — if it's a "not found" error, proceed
          if (lockError.message.includes("Could not find")) {
            console.warn("auto_trade_locks upsert failed (table not found) — running without lock.");
          } else {
            return new Response(JSON.stringify({
              skipped: true,
              reason: `Lock acquisition failed: ${lockError.message}`,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        } else {
          lockAcquired = true;
        }
      }
    } catch (lockErr) {
      console.warn("auto_trade_locks error — running without advisory lock:", lockErr instanceof Error ? lockErr.message : String(lockErr));
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

    // ── Load active strategies with their configs ────────────────────────────
    const { data: strategies } = await supabase
      .from("strategies")
      .select("id, name, description, instructions, mode, starting_balance, user_id")
      .eq("active", true)
      .order("id");

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
        let result: StrategyResult;

        if (strategy.id === "S-001") {
          result = await runS001FedWatchOracle(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId);
        } else if (strategy.id === "S-002") {
          result = await runS002LongshotBias(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId);
        } else if (strategy.id === "S-005") {
          result = await runS005WeatherEdge(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId);
        } else {
          // Unknown strategy — use generic signal-based handler
          result = await runGenericSignalStrategy(supabase, strategy, config, aiConfig, supabaseUrl, supabaseAnonKey, runId);
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

// ─── Strategy S-001: FedWatch Oracle ─────────────────────────────────────────
// Reads futures_oracle signals (inserted by futures-signal edge function) and
// places MAKER limit orders when CME FedWatch vs. Kalshi KXFED divergence ≥12¢.
//
// Edge source: CME FedWatch implied probabilities from $400B/day Fed funds
// futures are more accurate than Kalshi retail pricing for KXFED markets.
// When they diverge, trade Kalshi toward the FedWatch implied probability.

async function runS001FedWatchOracle(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
  runId?: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 12;
  const maxPositionUsd = config?.max_position_usd ?? 50;
  const MAX_S001_POSITIONS = 1000;

  const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: rawSignals } = await supabase
    .from("signals")
    .select("*")
    .eq("source", "futures_oracle")
    .gte("created_at", sixtyMinAgo)
    .gte("edge_cents", minEdge)
    .not("direction", "is", null)
    .order("edge_cents", { ascending: false })
    .limit(10);

  if (!rawSignals || rawSignals.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `No fresh FedWatch Oracle signals with edge ≥${minEdge}¢ (run futures-signal first)`,
    };
  }

  // Weighted position count: near-term (≤7d) = 1.0 slot, far-term = 0.5 slot
  const positions = await countOpenPositions(supabase, "S-001");
  const openS001Count = positions.weightedCost;
  const nearTermOnly = positions.nearTermCount;
  const farTermOnly = positions.farTermCount;

  if (openS001Count >= MAX_S001_POSITIONS) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `S-001 at max positions: weighted ${openS001Count.toFixed(1)}/${MAX_S001_POSITIONS} (near: ${nearTermOnly}, far: ${farTermOnly})`,
    };
  }

  const slotsAvailable = MAX_S001_POSITIONS - openS001Count;

  // Dedup: fetch open tickers to skip already-held positions
  const { data: s001OpenTrades } = await supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .eq("strategy_id", "S-001")
    .is("exit_reason", null)
    .is("settled_at", null);
  const openTickers = new Set((s001OpenTrades || []).map((t: any) => t.ticker));
  const seenTickers = new Set<string>();
  const candidates = (rawSignals || []).filter((s: any) => {
    if (openTickers.has(s.ticker)) return false;
    if (seenTickers.has(s.ticker)) return false;
    seenTickers.add(s.ticker);
    return true;
  }).slice(0, slotsAvailable);

  if (candidates.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: "All FedWatch Oracle signals already have open positions",
    };
  }

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const execResults = await Promise.all(candidates.map(async (sig: any) => {
    const edgeCents = sig.edge_cents || 12;
    const midPrice = sig.mid_price || 50;

    // Kelly-based position sizing capped at $50
    const trueP = sig.true_probability
      || (sig.direction === "buy_yes"
        ? (midPrice + edgeCents) / 100
        : (midPrice - edgeCents) / 100);
    const marketP = midPrice / 100;
    const amount = Math.min(maxPositionUsd, kellySize(trueP, marketP, 500, 0.25));

    // MAKER orders: rest inside the spread
    const side = sig.direction === "buy_yes" ? "yes" : "no";
    const price = sig.direction === "buy_yes"
      ? Math.max(1, Math.min(99, (sig.yes_bid || 50) + 1))
      : Math.max(1, Math.min(99, (100 - (sig.yes_ask || 50)) + 1));

    const qualifyPrompt = buildQualifyPrompt("S-001 FedWatch Oracle", {
      ticker: sig.ticker,
      market_question: sig.market_question,
      direction: sig.direction,
      edge_cents: edgeCents,
      mid_price: midPrice,
      yes_bid: sig.yes_bid,
      yes_ask: sig.yes_ask,
      true_probability: sig.true_probability,
      implied_probability: sig.implied_probability,
      days_to_close: sig.days_to_close,
      meeting_date_from_question: `Extracted from market_question: ${sig.market_question || sig.ticker}`,
      note: `FedWatch Oracle: Yahoo Finance ZQ futures imply a different rate probability than Kalshi, creating ${edgeCents}¢ edge. Mode: ${mode.toUpperCase()} — ${mode === "paper" ? "LEAN QUALIFY. QUALIFY whenever edge_cents >= 10 and the market_question contains a specific meeting date. The market_question above contains the meeting date." : "require unambiguous meeting date match."}. REJECT only if: market expires in < 12h, market_question has no meeting date at all, or prices are null.`,
    });

    const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt, mode, runId, strategy.id);
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
        price,
        amount,
        strategy: strategy.name,
        strategyId: strategy.id,
        orderType: "limit",
        mode,
        expirationTime: parseSettlementDate(sig.ticker)?.toISOString() || null,
        notes: `FedWatch Oracle: edge=${edgeCents}¢, fedwatch_p=${sig.true_probability}, kalshi_mid=${midPrice}¢, maker bid+1¢. ${reason}`,
        expectedOutcome: `${sig.direction} at ${price}¢ (maker), FedWatch p=${sig.true_probability}`,
        confidenceLevel: sig.composite_score,
        user_id: strategy.user_id || null,
        traceId: runId,
        sourceSignalId: sig.id || null,
        systemVersion: 'v2',
      }),
    });

    const result = await tradeResp.json().catch(() => ({ success: false, error: "parse failed" }));
    return { sig, success: result.success, detail: result.success ? `${sig.ticker} @ ${price}¢` : result.error };
  }));

  const filled = execResults.filter(r => r.success);
  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: filled.length > 0 ? "trade_executed" : "no_setup",
    details: filled.length > 0
      ? `FedWatch Oracle executed ${filled.length}/${candidates.length}: ${filled.map(r => r.detail).join(", ")}`
      : `No fills: ${execResults.map(r => r.detail).join("; ")}`,
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
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const MAX_S002_POSITIONS = 1000;
  // 8-11¢ YES range: EV is positive here. Below 8¢, the payout ratio (win ~9¢, lose ~91¢)
  // requires >91% win rate to break even — the longshot bias (~5pp edge) isn't enough.
  // Near-cert side (>88¢) removed: buying YES at 90¢ needs >90% win rate, we can't reliably hit that.
  const AMOUNT_PER_TRADE = 20;

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // Longshots only: YES ask 8-11¢. We buy NO on these markets.
  const { data: rawSignals } = await supabase
    .from("signals")
    .select("*")
    .lt("yes_ask", 12)
    .gte("yes_ask", 8)
    .gte("volume", 200)
    .gte("days_to_close", 0.08)
    .lte("days_to_close", 30)
    .gte("created_at", twoHoursAgo)
    .not("direction", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);

  // Hard block: no ETH, no sports series
  const blockedPrefixes = ["KXETH", "KXNHL", "KXNBA", "KXMLB", "KXNFL"];
  const signals = (rawSignals || []).filter((s: any) =>
    !blockedPrefixes.some(p => (s.ticker || "").toUpperCase().startsWith(p))
  );

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
  const positions = await countOpenPositions(supabase, "S-002");
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

  // Dedup: fetch open tickers to skip already-held positions
  const { data: s002OpenTrades } = await supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .eq("strategy_id", "S-002")
    .is("exit_reason", null)
    .is("settled_at", null);
  const openTickers = new Set((s002OpenTrades || []).map((t: any) => t.ticker));
  const seenTickers = new Set<string>();
  const candidates = signals.filter((s: any) => {
    if (openTickers.has(s.ticker)) return false;
    if (seenTickers.has(s.ticker)) return false;
    seenTickers.add(s.ticker);
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

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;

  const execResults = await Promise.all(candidates.map(async (sig: any) => {
    const yesAsk = sig.yes_ask || 10;

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
      note: `Longshot Bias (longshot-only mode): YES ask is ${yesAsk}¢, we buy NO at ~${price}¢. Academic research shows Kalshi markets in the 8-11¢ range resolve YES ~7% vs. 12% implied — we have a structural edge buying NO here. REJECT only if: market has an obvious volume pump (>10x normal), expiry in <6h, or the market question makes this specific event genuinely likely (e.g. breaking news). Do NOT reject just because the NO price is high — that is expected and correct for a longshot.`,
    });

    const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt, mode, runId, strategy.id);
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
  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: filled.length > 0 ? "trade_executed" : "no_setup",
    details: filled.length > 0
      ? `Longshot Bias executed ${filled.length}/${candidates.length}: ${filled.map(r => r.detail).join(", ")}`
      : `No fills: ${execResults.map(r => r.detail).join("; ")}`,
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
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 15; // raised from 8¢ — weather needs bigger edge
  const maxPositionUsd = config?.max_position_usd ?? 30;
  const MAX_PARALLEL_SIGNALS = 5;

  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .eq("source", "weather_signal_s005")
    .gte("created_at", thirtyMinAgo)
    .gte("edge_cents", minEdge)
    .not("direction", "is", null)
    .order("edge_cents", { ascending: false })
    .limit(MAX_PARALLEL_SIGNALS);

  if (!signals || signals.length === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `No fresh weather signals with edge >= ${minEdge}c (run weather-signal first)`,
    };
  }

  const positions = await countOpenPositions(supabase);
  const slotsAvailable = Math.max(0, 1000 - positions.weightedCost);
  if (slotsAvailable === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `Portfolio full: weighted ${positions.weightedCost.toFixed(1)}/1000 (near: ${positions.nearTermCount}, far: ${positions.farTermCount})`,
    };
  }

  // Dedup: skip tickers already held to prevent placing multiple trades on the same market
  // across auto-trade runs (signals stay fresh for 30 min; auto-trade runs every 10 min).
  const { data: openTrades } = await supabase
    .from("trades")
    .select("ticker")
    .eq("status", "filled")
    .is("exit_reason", null)
    .is("settled_at", null);
  const openTickers = new Set((openTrades || []).map((t: any) => t.ticker));
  const deduped = signals.filter((s: any) => !openTickers.has(s.ticker));

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

  if (cityTags.length > 0) {
    // Settled trades for weather tickers to get per-city win rates
    const { data: weatherTrades } = await supabase
      .from("trades")
      .select("ticker, pnl, notes")
      .eq("status", "settled")
      .eq("strategy_id", "S-005");

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

  // 3. LLM-gate all signals in parallel
  const qualifyResults = await Promise.all(
    candidates.map(async (sig: any) => {
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
        ...(lessonBlock ? { past_lessons: lessonBlock } : {}),
        note: `Weather Edge: GFS ensemble forecast vs Kalshi price. Mode: ${mode.toUpperCase()} — ${mode === "paper" ? "LEAN QUALIFY to collect data. QUALIFY whenever edge_cents >= 5 and data is fresh. Large divergences (e.g., true_prob=2% vs implied=60%) are EXPECTED and correct — that IS the edge." : "require edge >= 15¢."}. REJECT ONLY if: market expires in < 2h, city in ticker does not match location, or data is clearly corrupt (null prices). Do NOT reject based on the size of the divergence — large divergence is the signal.`,
      });
      const { qualified, reason } = await qualifySetup(aiConfig, prompt, mode, runId, strategy.id);
      return { sig, qualified, reason };
    })
  );

  const qualifiedList = qualifyResults.filter(r => r.qualified);
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
      // Pass dollar amount — execute-trade handles the cents→contract conversion.
      const amount = maxPositionUsd;

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

async function runGenericSignalStrategy(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
  runId?: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minComposite = config?.min_composite_score ?? 0.4;
  const maxPositionUsd = config?.max_position_usd ?? 50;

  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .gte("composite_score", minComposite)
    .not("direction", "is", null)
    .order("composite_score", { ascending: false })
    .limit(3);

  if (!signals || signals.length === 0) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "No qualifying signals" };
  }

  const best = signals[0];
  const qualifyPrompt = buildQualifyPrompt(`${strategy.name} (${strategy.id})`, {
    ticker: best.ticker,
    market_question: best.market_question,
    direction: best.direction,
    composite_score: best.composite_score,
    edge_cents: best.edge_cents,
    strategy_instructions: strategy.instructions?.slice(0, 400),
  });

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt, mode, runId, strategy.id);

  if (!qualified) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `LLM rejected: ${reason}` };
  }

  const side = best.direction === "buy_yes" ? "yes" : "no";
  const price = best.direction === "buy_yes" ? best.yes_ask : (100 - (best.yes_bid || 50));
  // Pass dollar amount — execute-trade handles the cents→contract conversion.
  // Old formula (maxPositionUsd * 100 / price) produced contract count, not dollars,
  // causing a double-conversion that inflated positions by ~100x at low prices.
  const amount = maxPositionUsd;

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const tradeResp = await fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      ticker: best.ticker,
      marketId: best.ticker,
      marketQuestion: best.market_question || best.ticker,
      side,
      action: "buy",
      price: Math.round(price),
      amount,
      strategy: strategy.name,
      strategyId: strategy.id,
      orderType: "limit",
      mode,
      expirationTime: parseSettlementDate(best.ticker)?.toISOString() || null,
      notes: `${strategy.id} auto-trade: ${reason}`,
      expectedOutcome: `${strategy.name}: ${best.direction} on ${best.ticker} at ${best.mid_price}c`,
      confidenceLevel: best.composite_score,
      user_id: strategy.user_id || null,
      traceId: runId,
    }),
  });

  const tradeResult = await tradeResp.json();

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: tradeResult.success ? "trade_executed" : "no_setup",
    details: tradeResult.success ? `Executed: ${reason}` : `Failed: ${tradeResult.error}`,
  };
}

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

    return { qualified, reason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
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
 */
async function resolveAiConfig(supabase: any): Promise<AiConfig | null> {
  // Check saved model preference
  const { data: savedModel } = await supabase
    .from("api_keys")
    .select("key_id")
    .eq("provider", "model_agent")
    .maybeSingle();

  const preferredModel = savedModel?.key_id;

  // Check available keys
  const { data: keyRows } = await supabase
    .from("api_keys")
    .select("provider, encrypted_secret")
    .in("provider", ["openrouter", "anthropic", "openai", "google"]);

  const keyMap = new Map((keyRows || []).map((r: any) => [r.provider, r.encrypted_secret]));

  const openrouterKey = keyMap.get("openrouter") || Deno.env.get("OPENROUTER_API_KEY");
  const anthropicKey = keyMap.get("anthropic") || Deno.env.get("ANTHROPIC_API_KEY");
  const openaiKey = keyMap.get("openai") || Deno.env.get("OPENAI_API_KEY");

  if (openrouterKey) {
    return {
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
      model: preferredModel || "openai/gpt-4o-mini",
      provider: "openrouter",
    };
  }
  if (anthropicKey) {
    // Anthropic has a different chat completions shape — use OpenAI-compat endpoint via openrouter
    // If only Anthropic key is available, skip (not OpenAI-compat without extra adapter)
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
