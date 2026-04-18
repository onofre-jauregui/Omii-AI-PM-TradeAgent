import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

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

const DEBOUNCE_MINUTES = 3;
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

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const runId = crypto.randomUUID();
  const runStartedAt = new Date().toISOString();

  try {
    // ── Debounce: skip if ran recently ───────────────────────────────────────
    const { data: recentRun } = await supabase
      .from("compliance_log")
      .select("created_at")
      .eq("event_type", "auto_trade_run")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentRun) {
      const lastRanMinutes = (Date.now() - new Date(recentRun.created_at).getTime()) / 60_000;
      if (lastRanMinutes < DEBOUNCE_MINUTES) {
        return new Response(JSON.stringify({
          skipped: true,
          reason: `Last run was ${lastRanMinutes.toFixed(1)} min ago (debounce: ${DEBOUNCE_MINUTES} min)`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
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
      .select("id, name, description, instructions, mode, starting_balance")
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
          result = await runS001SurfaceArb(supabase, strategy, config, aiConfig, supabaseUrl, supabaseKey);
        } else if (strategy.id === "S-002") {
          result = await runS002ResolutionFade(supabase, strategy, config, aiConfig, supabaseUrl, supabaseKey);
        } else if (strategy.id === "S-003") {
          // S-003 is disabled by 20260414_security_and_billing.sql migration
          // per Federal Reserve research showing Kalshi macro markets are
          // efficient. The strategies row is set to active=false and this
          // branch is a defensive guard in case it gets re-enabled without
          // a named edge thesis.
          result = {
            strategy_id: strategy.id,
            strategy_name: strategy.name,
            mode: strategy.mode,
            status: "halted",
            details: "S-003 is disabled per Fed paper evidence. See 20260414 migration for re-enable instructions.",
          };
        } else if (strategy.id === "S-004") {
          result = await runS004LiquidityProvision(supabase, strategy, config, aiConfig, supabaseUrl, supabaseKey);
        } else if (strategy.id === "S-005") {
          result = await runS005WeatherEdge(supabase, strategy, config, aiConfig, supabaseUrl, supabaseKey);
        } else {
          // Unknown strategy — use generic signal-based handler
          result = await runGenericSignalStrategy(supabase, strategy, config, aiConfig, supabaseUrl, supabaseKey);
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
  }
});

// ─── Strategy S-001: Surface Arbitrage ───────────────────────────────────────
// Looks for unexploited surface_alerts (monotonicity / bracket sum violations)
// and executes a multi-leg basket to capture the edge.

async function runS001SurfaceArb(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 3;
  const maxPositionUsd = config?.max_position_usd ?? 50;

  // 1. Read recent unexploited surface alerts above min edge
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: alerts } = await supabase
    .from("surface_alerts")
    .select("*")
    .eq("is_exploited", false)
    .gte("expected_edge_cents", minEdge)
    .gte("created_at", fiveMinAgo)
    .order("expected_edge_cents", { ascending: false })
    .limit(5);

  if (!alerts || alerts.length === 0) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "No fresh unexploited surface alerts above edge threshold" };
  }

  // 2. Check portfolio exposure
  const { openCount, totalUsd } = await checkPortfolioExposure(supabase);
  const maxPositions = 6;
  if (openCount >= maxPositions) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `Portfolio full: ${openCount} open positions` };
  }

  // 3. Pick the best alert and ask LLM to qualify or reject
  const bestAlert = alerts[0];
  const qualifyPrompt = buildQualifyPrompt("S-001 Surface Arbitrage", {
    alert_type: bestAlert.alert_type,
    ticker_a: bestAlert.ticker_a,
    ticker_b: bestAlert.ticker_b,
    edge_cents: bestAlert.expected_edge_cents,
    price_a_cents: bestAlert.price_a_cents,
    price_b_cents: bestAlert.price_b_cents,
    description: bestAlert.description,
    open_positions: openCount,
    portfolio_usd: totalUsd,
    max_position_usd: maxPositionUsd,
  });

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt);

  if (!qualified) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `LLM rejected: ${reason}` };
  }

  // 4. Execute the basket
  const contractSize = Math.min(
    Math.floor((maxPositionUsd / 2) * 100) / 100,
    25 // max $25 per leg in arb
  );

  const legs = buildArbLegs(bestAlert, contractSize);
  if (!legs || legs.length < 1) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "Could not construct basket legs from alert" };
  }

  const basketUrl = `${supabaseUrl}/functions/v1/execute-basket`;
  const basketResp = await fetch(basketUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      alert_id: bestAlert.id,
      legs,
      mode,
      expected_edge_cents: bestAlert.expected_edge_cents,
      reasoning: `S-001 auto-trade: ${reason}`,
    }),
  });

  const basketResult = await basketResp.json();

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: basketResult.success ? "basket_executed" : "no_setup",
    details: `Basket ${basketResult.basket_id}: ${basketResult.status}, legs filled: ${basketResult.legs_filled}/${basketResult.legs_total}${basketResult.abort_reason ? `. Abort: ${basketResult.abort_reason}` : ""}`,
  };
}

// ─── Strategy S-002: Resolution Fade ─────────────────────────────────────────
// Finds markets approaching resolution (high time_value_score) that are
// pricing at extreme levels (>75¢ or <25¢) with sufficient liquidity.
// Fades the current consensus by taking the contrarian position.

async function runS002ResolutionFade(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 5;
  const minComposite = config?.min_composite_score ?? 0.4;
  const minLiquidity = config?.min_liquidity_score ?? 0.3;
  const maxPositionUsd = config?.max_position_usd ?? 40;

  // 1. Read signals: near-resolution markets with strong edge
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .gte("time_value_score", 0.65)     // high urgency — within 2 weeks of close
    .gte("composite_score", minComposite)
    .gte("liquidity_score", minLiquidity)
    .gte("edge_cents", minEdge)
    .not("direction", "is", null)
    .in("direction", ["buy_yes", "buy_no"])
    .order("time_value_score", { ascending: false })
    .order("edge_cents", { ascending: false })
    .limit(5);

  if (!signals || signals.length === 0) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "No near-resolution signals meeting edge + liquidity requirements" };
  }

  const { openCount, totalUsd } = await checkPortfolioExposure(supabase);
  if (openCount >= 8) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `Portfolio full: ${openCount} open positions` };
  }

  const best = signals[0];
  const qualifyPrompt = buildQualifyPrompt("S-002 Resolution Fade", {
    ticker: best.ticker,
    market_question: best.market_question,
    direction: best.direction,
    mid_price: best.mid_price,
    edge_cents: best.edge_cents,
    time_value_score: best.time_value_score,
    liquidity_score: best.liquidity_score,
    composite_score: best.composite_score,
    days_to_close: best.days_to_close,
    open_positions: openCount,
    note: "Resolution Fade: fade consensus if market is mispriced near resolution. High time_value means price should be converging fast.",
  });

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt);

  if (!qualified) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `LLM rejected: ${reason}` };
  }

  const side = best.direction === "buy_yes" ? "yes" : "no";
  const price = best.direction === "buy_yes" ? best.yes_ask : best.no_ask || (100 - best.yes_bid);
  const amount = maxPositionUsd; // dollars — execute-trade handles cents→contract conversion

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const tradeResp = await fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
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
      notes: `S-002 auto-trade: ${reason}`,
      expectedOutcome: `Resolution Fade: ${best.direction} at mid ${best.mid_price}c, time_value ${best.time_value_score}, expected mean-reversion to base rate before resolution`,
      confidenceLevel: best.composite_score,
    }),
  });

  const tradeResult = await tradeResp.json();

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: tradeResult.success ? "trade_executed" : "no_setup",
    details: tradeResult.success
      ? `Bought ${amount} ${side} @ ${price}¢ on ${best.ticker}: ${reason}`
      : `Trade failed: ${tradeResult.error}`,
  };
}

// ─── Strategy S-003: Economic Consensus ──────────────────────────────────────
// Targets large-edge signals on economic data markets (Fed, CPI, employment).
// Higher edge threshold (15¢) means only very mispriced markets qualify.

async function runS003EconomicConsensus(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 15;
  const minLiquidity = config?.min_liquidity_score ?? 0.3;
  const maxPositionUsd = config?.max_position_usd ?? 75;
  const minDaysToClose = config?.min_days_to_close ?? 0.1;
  const maxDaysToClose = config?.max_days_to_close ?? 90;

  // 1. Read signals: high edge, sufficient liquidity, reasonable time window
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .gte("edge_cents", minEdge)
    .gte("liquidity_score", minLiquidity)
    .gte("days_to_close", minDaysToClose)
    .lte("days_to_close", maxDaysToClose)
    .not("direction", "is", null)
    .order("edge_cents", { ascending: false })
    .order("liquidity_score", { ascending: false })
    .limit(10);

  if (!signals || signals.length === 0) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `No signals with edge ≥ ${minEdge}¢` };
  }

  // Filter to economic/macro tickers — series that typically cover Fed, CPI, jobs, etc.
  const economicKeywords = ["fed", "cpi", "rate", "inflation", "unemployment", "gdp", "payroll", "fomc", "jobs", "interest"];
  const economicSignals = signals.filter((s: any) => {
    const q = (s.market_question || s.ticker || "").toLowerCase();
    return economicKeywords.some(kw => q.includes(kw));
  });

  // Fall back to highest-edge signals if no economic matches
  const candidates = economicSignals.length > 0 ? economicSignals : signals;
  const best = candidates[0];

  const { openCount, totalUsd } = await checkPortfolioExposure(supabase);
  if (totalUsd >= 200) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `Portfolio exposure too high: $${totalUsd.toFixed(0)}` };
  }

  const qualifyPrompt = buildQualifyPrompt("S-003 Economic Consensus", {
    ticker: best.ticker,
    market_question: best.market_question,
    direction: best.direction,
    mid_price: best.mid_price,
    edge_cents: best.edge_cents,
    days_to_close: best.days_to_close,
    liquidity_score: best.liquidity_score,
    is_economic: economicSignals.length > 0,
    open_positions: openCount,
    portfolio_usd: totalUsd,
    note: "Economic Consensus: trade only when edge is substantial (≥15¢) and reflects genuine consensus mispricing vs economic data/forecasts.",
  });

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt);

  if (!qualified) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `LLM rejected: ${reason}` };
  }

  const side = best.direction === "buy_yes" ? "yes" : "no";
  const price = best.direction === "buy_yes" ? best.yes_ask : best.no_ask || (100 - best.yes_bid);
  const amount = maxPositionUsd; // dollars — execute-trade handles cents→contract conversion

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const tradeResp = await fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
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
      notes: `S-003 auto-trade: ${reason}`,
      expectedOutcome: `Economic Consensus: ${best.direction} toward analyst consensus on ${best.ticker}`,
      confidenceLevel: best.composite_score,
    }),
  });

  const tradeResult = await tradeResp.json();

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: tradeResult.success ? "trade_executed" : "no_setup",
    details: tradeResult.success
      ? `Bought ${amount} ${side} @ ${price}¢ on ${best.ticker}: ${reason}`
      : `Trade failed: ${tradeResult.error}`,
  };
}

// ─── Strategy S-004: Liquidity Provision ─────────────────────────────────────
// Provides liquidity on high-volume, tight-spread markets.
// Looks for markets with strong liquidity scores where both sides have value
// (mid near 50¢ ± 30¢) to place two-sided orders and capture the spread.

async function runS004LiquidityProvision(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minLiquidity = config?.min_liquidity_score ?? 0.5;
  const maxPositionUsd = config?.max_position_usd ?? 20;

  // 1. Read highly liquid markets with spreads worth quoting
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .gte("liquidity_score", minLiquidity)
    .gte("volume_rank_score", 0.5)            // top half by volume
    .gte("days_to_close", 1)                  // at least 1 day left
    .lte("days_to_close", 30)                 // don't provide liquidity too far out
    .not("yes_ask", "is", null)
    .not("yes_bid", "is", null)
    .order("liquidity_score", { ascending: false })
    .order("volume_rank_score", { ascending: false })
    .limit(5);

  if (!signals || signals.length === 0) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "No highly liquid markets available for provision" };
  }

  // Pick market where spread is ≥ 3¢ (worth quoting) and mid is between 20-80¢ (liquid range)
  const best = signals.find((s: any) => {
    const spread = (s.yes_ask || 0) - (s.yes_bid || 0);
    const mid = (s.mid_price || 50);
    return spread >= 3 && mid >= 20 && mid <= 80;
  }) || signals[0];

  const spread = (best.yes_ask || 0) - (best.yes_bid || 0);
  if (spread < 3) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `Best spread too tight: ${spread}¢ (need ≥3¢)` };
  }

  const { openCount } = await checkPortfolioExposure(supabase);
  if (openCount >= 10) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: "Too many open positions for liquidity provision" };
  }

  const qualifyPrompt = buildQualifyPrompt("S-004 Liquidity Provision", {
    ticker: best.ticker,
    market_question: best.market_question,
    yes_bid: best.yes_bid,
    yes_ask: best.yes_ask,
    spread_cents: spread,
    mid_price: best.mid_price,
    liquidity_score: best.liquidity_score,
    volume_rank_score: best.volume_rank_score,
    days_to_close: best.days_to_close,
    note: "Liquidity Provision: buy YES at bid+1¢ to capture part of the spread. Only qualify if market is active, spread is healthy, and mid is in the 20-80¢ range.",
  });

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt);

  if (!qualified) {
    return { strategy_id: strategy.id, strategy_name: strategy.name, mode, status: "completed", action: "no_setup", details: `LLM rejected: ${reason}` };
  }

  // Place a single YES buy at bid+1¢ to earn part of the spread
  const bidPrice = Math.min((best.yes_bid || 0) + 1, (best.yes_ask || 99) - 1);
  const amount = maxPositionUsd; // dollars — execute-trade handles cents→contract conversion

  const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
  const tradeResp = await fetch(executeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ticker: best.ticker,
      marketId: best.ticker,
      marketQuestion: best.market_question || best.ticker,
      side: "yes",
      action: "buy",
      price: Math.round(bidPrice),
      amount,
      strategy: strategy.name,
      strategyId: strategy.id,
      orderType: "limit",
      mode,
      notes: `S-004 auto-trade: provide liquidity at bid+1¢. ${reason}`,
      expectedOutcome: `Liquidity Provision: capture bid-ask spread on ${best.ticker}, target take-profit when spread compresses`,
      confidenceLevel: best.liquidity_score,
    }),
  });

  const tradeResult = await tradeResp.json();

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    mode,
    status: "completed",
    action: tradeResult.success ? "trade_executed" : "no_setup",
    details: tradeResult.success
      ? `Provided liquidity: ${amount} yes @ ${bidPrice}¢ on ${best.ticker} (spread: ${spread}¢)`
      : `Trade failed: ${tradeResult.error}`,
  };
}

// ─── Strategy S-005: Weather Edge ────────────────────────────────────────────
// Reads signals produced by the weather-signal edge function (which compares
// NWS forecast distributions to Kalshi weather market prices) and executes
// trades when edge >= threshold and the model agrees with itself.
//
// Parallelized: all qualifying signals are LLM-gated simultaneously, so
// a 5-city run takes ~2s (one LLM round-trip) instead of 5 × 2s = 10s.

async function runS005WeatherEdge(
  supabase: any,
  strategy: any,
  config: StrategyConfig | undefined,
  aiConfig: AiConfig,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<StrategyResult> {
  const mode = strategy.mode || "paper";
  const minEdge = config?.min_edge_cents ?? 8;
  const maxPositionUsd = config?.max_position_usd ?? 30;
  const MAX_PARALLEL_SIGNALS = 5; // one per city

  // 1. Read fresh weather signals (last 30 minutes only — they go stale fast)
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

  const { openCount } = await checkPortfolioExposure(supabase);
  const slotsAvailable = Math.max(0, 6 - openCount);
  if (slotsAvailable === 0) {
    return {
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      mode,
      status: "completed",
      action: "no_setup",
      details: `Portfolio full: ${openCount} open positions`,
    };
  }

  // 2. LLM-gate all signals in parallel — each city is independent,
  //    no reason to wait for one before starting the next.
  const candidates = signals.slice(0, slotsAvailable);
  const qualifyResults = await Promise.all(
    candidates.map(async (sig: any) => {
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
        note: "Weather Edge: model probability from NWS forecast. Quantitative strategy — qualify unless market is resolved, city mismatches ticker, or data is clearly missing.",
      });
      const { qualified, reason } = await qualifySetup(aiConfig, prompt);
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
      const price = sig.direction === "buy_yes"
        ? sig.yes_ask
        : 100 - (sig.yes_bid || 50);
      // Pass dollar amount — execute-trade handles the cents→contract conversion.
      const amount = maxPositionUsd;

      const tradeResp = await fetch(executeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
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
          notes: `S-005 auto-trade: edge=${sig.edge_cents}c, true_p=${sig.true_probability}, ${reason}`,
          expectedOutcome: `NWS model: ${sig.direction} (true_p=${sig.true_probability}, implied_p=${sig.implied_probability})`,
          confidenceLevel: sig.true_probability,
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
      ? `${failed.length} failed: ${failed.map(r => r.result.error).join(", ")}`
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

  const { qualified, reason } = await qualifySetup(aiConfig, qualifyPrompt);

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
    headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
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
      notes: `${strategy.id} auto-trade: ${reason}`,
      expectedOutcome: `${strategy.name}: ${best.direction} on ${best.ticker} at ${best.mid_price}c`,
      confidenceLevel: best.composite_score,
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
 * Build a focused qualify/reject prompt for the LLM.
 * Returns exactly one decision: QUALIFY or REJECT + one-sentence reason.
 */
function buildQualifyPrompt(strategyName: string, context: Record<string, any>): string {
  const ctx = Object.entries(context)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return `You are a trading judge for the "${strategyName}" strategy on Kalshi prediction markets.

Review this specific setup and decide: QUALIFY or REJECT.

Setup details:
${ctx}

Rules for QUALIFY:
- The opportunity is genuine and matches the strategy's intent
- Market is liquid enough to fill at the given price
- The edge is real, not noise
- No obvious reason the market is mispriced in the other direction

Rules for REJECT:
- Edge looks like noise or stale data
- Market has very low activity or closing imminently with no edge
- Position would be correlated with existing risk
- Any other strong reason to skip

Respond in exactly this format:
QUALIFY
Reason: [one sentence explaining why this qualifies]

OR:

REJECT
Reason: [one sentence explaining why this is rejected]`;
}

/**
 * Call the AI API with a qualify/reject prompt.
 * Returns { qualified: boolean, reason: string }.
 */
async function qualifySetup(aiConfig: AiConfig, prompt: string): Promise<{ qualified: boolean; reason: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), QUALIFY_TIMEOUT_MS);

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
    const text = (data?.choices?.[0]?.message?.content || "").trim();
    const upper = text.toUpperCase();
    const qualified = upper.startsWith("QUALIFY");

    // Extract reason line
    const reasonMatch = text.match(/Reason:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : text.slice(0, 150);

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
async function checkPortfolioExposure(supabase: any): Promise<{ openCount: number; totalUsd: number }> {
  const { data: open } = await supabase
    .from("trades")
    .select("amount, price")
    .eq("status", "filled")
    .is("exit_reason", null);

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
