import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { sendTelegramAlert, alertOnce } from "../_shared/telegram.ts";

/**
 * auto-reflect v2: Automated learning loop — Bayesian memory, Sharpe-based
 * strategy health, and direct signal-trade linkage.
 *
 * 1. Bayesian memory confidence: Beta posterior replaces +5%/-10% rules
 * 2. Strategy health v2: rolling Sharpe + drawdown replaces consecutive-loss count
 * 3. Unreflected trade count
 * 4. Signal outcome tracking via source_signal_id (no more 2-hour heuristic)
 * 5. Lesson writing from settled trades (6-hour window)
 * 6. Memory compaction
 *
 * Triggered by pg_cron every 15 minutes (see v2 migration).
 * Can also be called manually via POST.
 */

const LESSON_WINDOW_HOURS = 6; // tightened from 24h — faster feedback loop
const MEMORY_UPDATE_COOLDOWN_MS = 60 * 60 * 1000; // don't re-process within 1 hour
const DECAY_HALF_LIFE_DAYS = 30;
const MIN_SAMPLE_TO_EXPOSE = 5;
const QUARANTINE_THRESHOLD = 0.30;
const QUARANTINE_MIN_SAMPLE = 10;

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
  const results: Record<string, any> = {};

  try {
    // ── 1. Bayesian Memory Confidence Updates ─────────────────────
    // Uses Beta(α, β) posterior instead of rule-based +5%/-10%.
    // Each settled attribution increments α (win) or β (loss).
    // exposed_confidence = posterior_mean × time_decay, gated on sample size.

    const { data: activeMemories } = await supabase
      .from("agent_memory")
      .select("id, title, is_active, alpha, beta, trade_sample_size, last_updated_at, quarantined_at")
      .eq("is_active", true);

    let memoriesUpdated = 0;
    let memoriesQuarantined = 0;

    for (const mem of activeMemories || []) {
      // Don't re-process if updated recently
      const lastUpdate = new Date(mem.last_updated_at || mem.updated_at || "1970-01-01").getTime();
      if (Date.now() - lastUpdate < MEMORY_UPDATE_COOLDOWN_MS) continue;

      // Find newly settled attributions since last update
      const { data: attributions } = await supabase
        .from("memory_attribution")
        .select("trade_pnl")
        .eq("memory_id", mem.id)
        .not("settled_at", "is", null)
        .gt("settled_at", new Date(lastUpdate).toISOString());

      if (!attributions || attributions.length === 0) continue;

      let alpha = Number(mem.alpha) || 1;
      let beta = Number(mem.beta) || 1;
      let sample = Number(mem.trade_sample_size) || 0;

      for (const attr of attributions) {
        const pnl = Number(attr.trade_pnl) || 0;
        if (pnl > 0) alpha += 1;
        else if (pnl < 0) beta += 1;
        sample += 1;
      }

      // Posterior mean
      const posteriorMean = alpha / (alpha + beta);

      // Time decay on exposed confidence
      const ageDays = (Date.now() - lastUpdate) / (24 * 60 * 60 * 1000);
      const decay = 0.5 ** (ageDays / DECAY_HALF_LIFE_DAYS);

      // Sample-size gate: don't expose until ≥5 trades
      const exposedConfidence = sample >= MIN_SAMPLE_TO_EXPOSE
        ? posteriorMean * decay
        : null;

      // Quarantine check
      let quarantinedAt = mem.quarantined_at;
      if (sample >= QUARANTINE_MIN_SAMPLE &&
          exposedConfidence !== null &&
          exposedConfidence < QUARANTINE_THRESHOLD &&
          !quarantinedAt) {
        quarantinedAt = new Date().toISOString();
        memoriesQuarantined++;
        await supabase.from("compliance_log").insert({
          event_type: "memory_quarantined",
          severity: "warning",
          message: `Memory quarantined: "${mem.title}" — exposed confidence ${(exposedConfidence * 100).toFixed(1)}% after ${sample} trades (α=${alpha}, β=${beta})`,
          metadata: { memory_id: mem.id, exposed_confidence: exposedConfidence, sample_size: sample },
        });
      }

      await supabase.from("agent_memory").update({
        alpha,
        beta,
        trade_sample_size: sample,
        exposed_confidence: exposedConfidence,
        quarantined_at: quarantinedAt,
        last_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", mem.id);

      memoriesUpdated++;
    }

    results.bayesian_memory = {
      memories_checked: (activeMemories || []).length,
      updated: memoriesUpdated,
      quarantined: memoriesQuarantined,
    };

    // ── 2. Strategy Health v2 — Sharpe + Drawdown ──────────────────
    // Replaces consecutive-loss counting with rolling metrics over last 30 trades.
    // Suspension triggers:
    //   Sharpe < -1.0 with n≥20 → suspend 24h (sharpe_collapse)
    //   Max drawdown > max_acceptable_drawdown → suspend 24h (drawdown_breach)
    //   Hit rate < expected - 0.20 with n≥20 → suspend 72h (hit_rate_regime_shift)
    //   5+ consecutive losses → suspend 12h (consecutive_loss_streak)

    const { data: strategies } = await supabase
      .from("strategies")
      .select("id, name, active, starting_balance, mode, suspended_until, updated_at, expected_hit_rate, max_acceptable_drawdown, suspension_reason, user_id");

    const strategyResults: any[] = [];

    // ── 2a. Auto-re-enable strategies past their suspension window ──
    let strategiesResumed = 0;
    const now = new Date();
    for (const strat of strategies || []) {
      if (strat.active) continue;
      if (!strat.suspended_until) continue;
      if (new Date(strat.suspended_until) > now) continue;

      await supabase.from("strategies").update({
        active: true,
        suspended_until: null,
        suspension_reason: null,
        updated_at: now.toISOString(),
      }).eq("id", strat.id);

      await supabase.from("compliance_log").insert({
        event_type: "strategy_resumed",
        severity: "info",
        message: `Strategy "${strat.name}" auto-resumed after suspension window ended.`,
        metadata: { strategy_id: strat.id, suspension_reason: strat.suspension_reason },
      });

      strategiesResumed++;
    }

    // ── 2b. Evaluate active strategies with rolling metrics ──
    const activeStrategies = (strategies || []).filter((s: any) => s.active);

    for (const strat of activeStrategies) {
      // Fetch last 30 settled trades, oldest first for cumulative calculations
      const { data: rawTrades } = await supabase
        .from("trades")
        .select("pnl, settled_at, status")
        .eq("status", "filled")
        .not("settled_at", "is", null)
        .or(`strategy_id.eq.${strat.id},strategy.eq.${strat.name}`)
        .order("settled_at", { ascending: true })
        .limit(30);

      if (!rawTrades || rawTrades.length === 0) {
        // Also check for any trades (not yet settled)
        const { data: anyTrades } = await supabase
          .from("trades")
          .select("id")
          .eq("status", "filled")
          .or(`strategy_id.eq.${strat.id},strategy.eq.${strat.name}`)
          .limit(1);

        strategyResults.push({
          id: strat.id,
          name: strat.name,
          trades: rawTrades?.length || 0,
          settled: anyTrades?.length ? 0 : "no trades yet",
          action: "skipped",
        });
        continue;
      }

      const pnls = rawTrades.map((t: any) => Number(t.pnl) || 0);
      const n = pnls.length;

      // Rolling Sharpe (per-trade)
      const mean = pnls.reduce((s: number, p: number) => s + p, 0) / n;
      const variance = pnls.reduce((s: number, p: number) => s + (p - mean) ** 2, 0) / n;
      const std = Math.sqrt(variance);
      const sharpe = std > 0 ? mean / std : 0;

      // Max drawdown on cumulative PnL
      let peak = 0;
      let running = 0;
      let maxDdPct = 0;
      for (const p of pnls) {
        running += p;
        peak = Math.max(peak, running);
        if (peak > 0) {
          const dd = (peak - running) / peak;
          maxDdPct = Math.max(maxDdPct, dd);
        }
      }

      // Hit rate
      const wins = pnls.filter((p: number) => p > 0).length;
      const hitRate = wins / n;

      // Consecutive losses (soft warning only)
      let consecutiveLosses = 0;
      for (let i = pnls.length - 1; i >= 0; i--) {
        if (pnls[i] < 0) consecutiveLosses++;
        else break;
      }

      const totalPnl = pnls.reduce((s: number, p: number) => s + p, 0);
      const tag = strat.name.toLowerCase().replace(/\s+/g, "_");
      const expectedHr = Number(strat.expected_hit_rate) || 0.50;
      const maxAcceptableDd = Number(strat.max_acceptable_drawdown) || 0.25;

      // Suspension logic
      if (sharpe < -1.0 && n >= 20) {
        const suspendUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies").update({
          active: false,
          suspended_until: suspendUntil,
          suspension_reason: "sharpe_collapse",
          updated_at: now.toISOString(),
        }).eq("id", strat.id);

        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended_sharpe",
          severity: "warning",
          message: `Strategy "${strat.name}" suspended 24h — Sharpe ${sharpe.toFixed(2)} over ${n} trades. Total P&L: $${totalPnl.toFixed(2)}.`,
          metadata: { strategy_id: strat.id, sharpe, n, totalPnl, max_drawdown: maxDdPct, hit_rate: hitRate },
        });

        strategyResults.push({ id: strat.id, name: strat.name, sharpe, action: "suspended_sharpe" });

      } else if (maxDdPct > maxAcceptableDd && n >= 10) {
        const suspendUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies").update({
          active: false,
          suspended_until: suspendUntil,
          suspension_reason: "drawdown_breach",
          updated_at: now.toISOString(),
        }).eq("id", strat.id);

        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended_drawdown",
          severity: "warning",
          message: `Strategy "${strat.name}" suspended 24h — max drawdown ${(maxDdPct * 100).toFixed(1)}% exceeds ${(maxAcceptableDd * 100).toFixed(0)}% threshold.`,
          metadata: { strategy_id: strat.id, max_drawdown: maxDdPct, threshold: maxAcceptableDd, n, totalPnl },
        });

        strategyResults.push({ id: strat.id, name: strat.name, max_drawdown: maxDdPct, action: "suspended_drawdown" });

      } else if (hitRate < expectedHr - 0.20 && n >= 20) {
        const suspendUntil = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies").update({
          active: false,
          suspended_until: suspendUntil,
          suspension_reason: "hit_rate_regime_shift",
          updated_at: now.toISOString(),
        }).eq("id", strat.id);

        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended_hitrate",
          severity: "warning",
          message: `Strategy "${strat.name}" suspended 72h — hit rate ${(hitRate * 100).toFixed(0)}% vs expected ${(expectedHr * 100).toFixed(0)}% over ${n} trades.`,
          metadata: { strategy_id: strat.id, hit_rate: hitRate, expected_hit_rate: expectedHr, n },
        });

        strategyResults.push({ id: strat.id, name: strat.name, hit_rate: hitRate, action: "suspended_hitrate" });

      } else if (consecutiveLosses >= 5) {
        // Suspend for 12h — auto-resume is handled by the loop above.
        const suspendUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies")
          .update({ suspended_until: suspendUntil, suspension_reason: "consecutive_loss_streak", active: false })
          .eq("id", strat.id);
        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended_loss_streak",
          severity: "warning",
          message: `Strategy "${strat.name}" suspended 12h — ${consecutiveLosses} consecutive losses. Sharpe: ${sharpe.toFixed(2)}, drawdown: ${(maxDdPct * 100).toFixed(1)}%.`,
          metadata: { strategy_id: strat.id, consecutiveLosses, sharpe, max_drawdown: maxDdPct, hit_rate: hitRate },
        });

        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "suspended_loss_streak" });

      } else {
        strategyResults.push({ id: strat.id, name: strat.name, sharpe, max_drawdown: maxDdPct, hit_rate: hitRate, consecutiveLosses, action: "healthy" });
      }
    }

    results.strategy_health_v2 = {
      strategies_checked: (strategies || []).length,
      active_evaluated: activeStrategies.length,
      resumed: strategiesResumed,
      details: strategyResults,
    };

    // ── 3. Unreflected Trade Count ───────────────────────────────
    const { data: allFilled } = await supabase
      .from("trades")
      .select("id")
      .eq("status", "filled");

    const filledIds = (allFilled || []).map((t: any) => t.id);

    let unreflectedCount = 0;
    if (filledIds.length > 0) {
      const { data: reflected } = await supabase
        .from("trade_reflections")
        .select("trade_id")
        .in("trade_id", filledIds);

      const reflectedIds = new Set((reflected || []).map((r: any) => r.trade_id));
      unreflectedCount = filledIds.filter((id: string) => !reflectedIds.has(id)).length;
    }

    results.unreflected_trades = unreflectedCount;

    // ── 4. Signal Outcome Tracking via source_signal_id ───────────
    // Direct linkage — no more 2-hour time-window heuristic.
    // Sets direction_correct and profitable on signals from trade outcomes.

    let signalsUpdated = 0;
    try {
      await supabase.rpc("update_signal_outcomes_from_trades").catch(() => {
        // RPC may not exist — use raw query fallback
      });

      // Fallback: direct UPDATE from trades where source_signal_id is set
      const { data: linkedSignals } = await supabase
        .from("signals")
        .select("id")
        .eq("was_acted_on", true)
        .is("direction_correct", null)
        .limit(100);

      for (const sig of linkedSignals || []) {
        // Find the trade with this signal as source
        const { data: trade } = await supabase
          .from("trades")
          .select("pnl, side, action")
          .eq("source_signal_id", sig.id)
          .eq("status", "filled")
          .not("settled_at", "is", null)
          .limit(1)
          .single();

        if (!trade) continue;

        const pnl = Number(trade.pnl) || 0;
        const directionMatch = (trade.side === "yes" && trade.action === "buy" && sig.direction === "buy_yes") ||
                               (trade.side === "no" && trade.action === "buy" && sig.direction === "buy_no");

        await supabase.from("signals").update({
          direction_correct: directionMatch,
          profitable: pnl > 0,
          outcome_pnl: pnl,
          outcome_correct: directionMatch && pnl > 0, // deprecated but kept for compat
        }).eq("id", sig.id);

        signalsUpdated++;
      }
    } catch (signalErr) {
      console.error("Signal outcome tracking error:", signalErr);
    }

    results.signal_outcomes = { updated: signalsUpdated };

    // ── 5. Write Lessons from Recently Settled Trades ────────────
    // Primary: 6-hour rolling window for fast feedback.
    // Catch-up: also pick up settled trades with no lesson entry ever written
    // (guards against schema bugs or function crashes that cause permanent gaps).
    //
    // Lessons are generated by an LLM (GPT-4o-mini via OpenRouter) rather than
    // string templates. This gives causal reasoning, directional error analysis,
    // and concrete IF/THEN filter rules instead of generic tautologies.

    let lessonsWritten = 0;
    try {
      // Load AI key for lesson generation — same pattern as compact-memory
      const { data: lessonKeyRows } = await supabase
        .from("api_keys")
        .select("provider, encrypted_secret")
        .in("provider", ["openrouter", "openai"]);
      const lessonKeys: Record<string, string> = {};
      for (const row of lessonKeyRows || []) {
        if (row.encrypted_secret) lessonKeys[row.provider] = row.encrypted_secret;
      }
      if (!lessonKeys["openrouter"]) lessonKeys["openrouter"] = Deno.env.get("OPENROUTER_API_KEY") || "";
      if (!lessonKeys["openai"]) lessonKeys["openai"] = Deno.env.get("OPENAI_API_KEY") || "";
      const lessonAiKey = lessonKeys["openrouter"] || lessonKeys["openai"];
      const lessonAiBaseUrl = lessonKeys["openrouter"] ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
      const lessonAiModel = lessonKeys["openrouter"] ? "openai/gpt-4o-mini" : "gpt-4o-mini";

      const windowAgo = new Date(Date.now() - LESSON_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data: recentSettled } = await supabase
        .from("trades")
        .select("id, user_id, strategy_id, ticker, side, price, pnl, resolution, notes, settled_at, user_rating")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .neq("pnl", 0)
        .gte("settled_at", windowAgo);

      // Catch-up: settled trades with nonzero pnl that have never received a lesson.
      // No time limit — recovers from schema bugs, function crashes, or window misses.
      const { data: existingLessonTradeIds } = await supabase
        .from("trade_lessons")
        .select("trade_id");
      const learnedTradeIds = new Set((existingLessonTradeIds || []).map((r: any) => r.trade_id));

      const { data: catchUpSettled } = await supabase
        .from("trades")
        .select("id, user_id, strategy_id, ticker, side, price, pnl, resolution, notes, settled_at, user_rating")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .neq("pnl", 0)
        .lt("settled_at", windowAgo) // older than the primary window
        .order("settled_at", { ascending: false }) // most recent orphans first
        .limit(20); // cap to avoid runaway processing

      // Merge: primary window trades + orphaned catch-up trades (no lesson yet)
      const catchUpFiltered = (catchUpSettled || []).filter((t: any) => !learnedTradeIds.has(t.id));
      const allTradesToProcess = [...(recentSettled || []), ...catchUpFiltered];

      const settledIds = allTradesToProcess.map((t: any) => t.id);
      const existingLessons = settledIds.length > 0
        ? (await supabase.from("trade_lessons").select("trade_id").in("trade_id", settledIds)).data || []
        : [];
      const alreadyLearned = new Set(existingLessons.map((r: any) => r.trade_id));

      // Single source of truth — MUST MATCH the trade_lessons_lesson_type_check constraint in the DB.
      // When adding a type here, also run a migration to extend that constraint.
      const validLessonTypes = ["forecast_bias", "market_timing", "stale_signal", "kelly_mismatch", "signal_quality", "execution", "market_structure", "general"];

      for (const trade of allTradesToProcess) {
        if (alreadyLearned.has(trade.id)) continue;

        const pnl = Number(trade.pnl);
        const price = Number(trade.price);
        const outcome = pnl > 0 ? "win" : "loss";
        const notes = trade.notes || "";

        // Pull recent lessons from same strategy for context (helps LLM spot patterns)
        const { data: priorLessons } = await supabase
          .from("trade_lessons")
          .select("ticker, lesson_type, lesson, outcome")
          .eq("strategy_id", trade.strategy_id)
          .gte("created_at", sevenDaysAgo)
          .order("created_at", { ascending: false })
          .limit(5);
        const priorContext = (priorLessons || [])
          .map((l: any) => `[${l.lesson_type}/${l.outcome}] ${l.ticker}: ${l.lesson}`)
          .join("\n") || "none";

        // ── LLM-generated lesson (GPT-4o-mini, ~$0.001/trade) ──
        // Falls back to deterministic template if LLM unavailable or parse fails.
        let lesson_type = "general";
        let lesson = "";
        let do_differently = "";
        let llmShouldPromote = false;
        let llmMarketTags: string[] = [];
        let llmPromotionReason: string | null = null;
        let llmUsed = false;

        if (lessonAiKey) {
          try {
            const lessonPrompt = `You are a trading post-mortem analyst for a Kalshi prediction market agent.

A trade has settled. Write a structured lesson so the agent avoids repeating mistakes and reinforces winning patterns.

Trade details:
- Ticker: ${trade.ticker}
- Strategy: ${trade.strategy_id || "unknown"}
- Side bought: ${trade.side} at ${price}¢ (implied ${price}% probability)
- Outcome: ${outcome.toUpperCase()} — P&L: $${pnl.toFixed(2)}
- Market resolved: ${trade.resolution || "unknown"}
- Signal notes: ${notes.slice(0, 300) || "none"}${trade.user_rating ? `\n- User rating: ${trade.user_rating === "good" ? "GOOD — user explicitly approved this trade decision" : "BAD — user explicitly flagged this as a poor decision"}` : ""}${(() => {
  const staleMatch = notes.match(/signal_age=(\d+)m.*live_edge=(-?[\d.]+)c/);
  const sigEdgeMatch = notes.match(/edge=(\d+)c/);
  if (!staleMatch) return "";
  const ageMin = parseInt(staleMatch[1]);
  const liveEdge = parseFloat(staleMatch[2]);
  const sigEdge = sigEdgeMatch ? parseInt(sigEdgeMatch[1]) : null;
  return `\n- Signal age at trade time: ${ageMin} min | Live edge at trade: ${liveEdge.toFixed(1)}¢${sigEdge !== null ? ` (signal had ${sigEdge}¢ when written)` : ""}\n- Staleness delta: ${sigEdge !== null ? (sigEdge - liveEdge).toFixed(0) : "?"}¢ of edge evaporated between signal write and trade execution`;
})()}

Recent lessons from same strategy (last 7 days):
${priorContext}

Root cause taxonomy — pick the MOST SPECIFIC type that applies:
- forecast_bias: GFS/NWS model was systematically wrong for this city/bucket/season
- market_timing: market already repriced before trade (stale signal, new obs came in)
- stale_signal: signal_age > 60 min AND live_edge was materially lower than signal edge (check "Staleness delta" above)
- kelly_mismatch: position size was wrong for the payout geometry (e.g., $8 at risk to win $0.70 on a NO bet)
- signal_quality: signal generation had a structural flaw (wrong edge formula, calibration error)
- execution: order mechanics issue (fill price wrong, order rejected)
- market_structure: general market behavior (liquidity, spread, closing time)
- general: use only if none of the above fit

Return ONLY valid JSON, no markdown, no extra text:
{
  "lesson_type": "forecast_bias" | "market_timing" | "stale_signal" | "kelly_mismatch" | "signal_quality" | "execution" | "market_structure" | "general",
  "lesson": "<specific causal sentence — for losses include direction of error; for wins include what structural edge made this correct>",
  "do_differently": "<concrete IF/THEN rule, e.g. 'IF city=MIA AND month=May AND side=NO AND price>30¢ THEN REJECT' or 'IF bracket spread > 25¢ and volume > 500 THEN QUALIFY'>",
  "should_promote": true | false,
  "promotion_reason": "<one sentence on why this belongs in permanent memory, or null if should_promote=false>",
  "market_tags": ["<ticker_prefix_lowercase>", "<city_if_weather>", "<market_category>", "<month_if_seasonal>"]
}`;

            const llmResp = await fetch(`${lessonAiBaseUrl}/chat/completions`, {
              method: "POST",
              headers: { Authorization: `Bearer ${lessonAiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: lessonAiModel,
                messages: [{ role: "user", content: lessonPrompt }],
                temperature: 0,
                max_tokens: 400,
              }),
            });

            if (llmResp.ok) {
              const llmData = await llmResp.json();
              const rawText = llmData.choices?.[0]?.message?.content || "";
              // Strip markdown code fences if present
              const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
              const parsed = JSON.parse(jsonText);

              if (parsed && typeof parsed.lesson === "string" && typeof parsed.do_differently === "string") {
                lesson_type = validLessonTypes.includes(parsed.lesson_type) ? parsed.lesson_type : "general";
                lesson = parsed.lesson.slice(0, 500);
                do_differently = parsed.do_differently.slice(0, 300);
                llmShouldPromote = parsed.should_promote === true;
                llmMarketTags = Array.isArray(parsed.market_tags) ? parsed.market_tags.map((t: any) => String(t).toLowerCase()) : [];
                llmPromotionReason = parsed.promotion_reason || null;
                llmUsed = true;
              }
            }
          } catch (llmErr) {
            // LLM call failed — fall through to template fallback below
            console.warn("Lesson LLM call failed, using template fallback:", llmErr instanceof Error ? llmErr.message : llmErr);
            await supabase.from("compliance_log").insert({
              event_type: "lesson_llm_fallback",
              severity: "warning",
              message: `Lesson LLM failed for ${trade.ticker} — using template. Error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
              metadata: { trade_id: trade.id, ticker: trade.ticker },
            }).then(undefined, () => {});
          }
        }

        // Template fallback (used when no AI key or LLM call fails)
        if (!llmUsed) {
          if (outcome === "loss") {
            if (price < 10 || price > 90) {
              lesson_type = "signal_quality";
              lesson = `Entered at ${price}¢ on ${trade.ticker}. Market already priced — not an edge. Lost $${Math.abs(pnl).toFixed(2)}.`;
              do_differently = "IF price < 10¢ OR price > 90¢ THEN REJECT — market already resolved at extremes.";
            } else if (notes.includes("true_p=")) {
              lesson_type = "forecast_bias";
              lesson = `S-005 loss on ${trade.ticker} at ${price}¢. GFS model probability did not match market outcome. Lost $${Math.abs(pnl).toFixed(2)}.`;
              do_differently = "IF GFS true_p diverges from market price by > 30pp AND prior losses on this city in last 7 days >= 2 THEN REJECT.";
            } else {
              lesson_type = "market_timing";
              lesson = `Loss on ${trade.ticker}: bought ${trade.side} at ${price}¢. Lost $${Math.abs(pnl).toFixed(2)}.`;
              do_differently = "IF same ticker_prefix has 2+ losses in last 7 days THEN REJECT next signal.";
            }
          } else {
            lesson_type = "general";
            lesson = `Win on ${trade.ticker}: bought ${trade.side} at ${price}¢. Profit $${pnl.toFixed(2)}.`;
            do_differently = "IF similar setup (same ticker_prefix, same side, similar price range) THEN QUALIFY.";
          }
        }

        // ── Insert trade_lesson ──
        const tickerBase = trade.ticker.split("-")[0].toLowerCase();
        const lessonTags = llmUsed
          ? [...new Set([trade.strategy_id?.toLowerCase(), lesson_type, outcome, tickerBase, ...llmMarketTags].filter(Boolean))]
          : [trade.strategy_id?.toLowerCase(), lesson_type, outcome, tickerBase].filter(Boolean);

        const lessonPayload = {
          trade_id: trade.id,
          user_id: trade.user_id ?? null,
          ticker: trade.ticker,
          strategy_id: trade.strategy_id,
          outcome,
          lesson_type,
          lesson,
          do_differently,
          confidence: 0.8,
          tags: lessonTags,
          trade_context: { price, pnl, resolution: trade.resolution, notes: notes.slice(0, 200), llm_generated: llmUsed, user_rating: trade.user_rating ?? null },
        };

        let { data: insertedLesson, error: lessonInsertError } = await supabase
          .from("trade_lessons")
          .insert(lessonPayload)
          .select("id")
          .single();

        // Moat guard: if lesson_type drifts ahead of the DB check constraint (code adds a
        // new type before the migration lands), Postgres rejects the row with 23514 and the
        // lesson — the asset the whole learning loop exists to capture — would be dropped.
        // Fall back to 'general' (always in the constraint) so the lesson content survives,
        // and log the drift so the constraint gets updated. This exact drift on 'stale_signal'
        // silently lost ~80 lessons over 3 days (2026-07-03→07-06) before it was caught.
        if (lessonInsertError?.code === "23514" && /lesson_type/.test(lessonInsertError.message ?? "")) {
          await supabase.from("compliance_log").insert({
            event_type: "lesson_type_constraint_drift",
            severity: "warning",
            message: `lesson_type "${lesson_type}" rejected by DB constraint; retried as "general" for trade ${trade.id} (${trade.ticker}). Add "${lesson_type}" to trade_lessons_lesson_type_check.`,
            metadata: { trade_id: trade.id, ticker: trade.ticker, rejected_lesson_type: lesson_type },
          }).then(undefined, () => {});
          ({ data: insertedLesson, error: lessonInsertError } = await supabase
            .from("trade_lessons")
            .insert({ ...lessonPayload, lesson_type: "general" })
            .select("id")
            .single());
        }

        if (lessonInsertError) {
          await supabase.from("compliance_log").insert({
            event_type: "lesson_write_error",
            severity: "error",
            message: `Failed to write lesson for trade ${trade.id} (${trade.ticker}): ${lessonInsertError.message}`,
            metadata: { trade_id: trade.id, ticker: trade.ticker, error: lessonInsertError },
          });
          // Dedupe on the error signature (not the trade) so a persistent write failure
          // alerts once per 2h instead of once per failing trade per reflect cycle — this
          // raw-send path is what turned the 2026-07-03→06 constraint drift into a Telegram
          // storm. Mirrors the deduped alert on the outer catch below.
          await alertOnce(
            supabase,
            "lesson_write_error",
            (lessonInsertError.message ?? "").slice(0, 60),
            2,
            `⚠️ <b>[TradeAgent] Learning Loop Error</b>\ntrade_lessons INSERT failed for ${trade.ticker}: ${lessonInsertError.message}`,
          ).catch(() => {});
          continue;
        }

        if (insertedLesson?.id) {
          await supabase
            .from("trade_reflections")
            .update({ lesson_id: insertedLesson.id })
            .eq("trade_id", trade.id);
        }

        // ── Pattern-aware promotion to agent_memory ──
        // Promotes when: LLM flagged it, 2+ losses OR 3+ wins same ticker in 7 days,
        // absP >= $10, or user explicitly rated the trade.
        const absP = Math.abs(pnl);
        const [lossPatternRes, winPatternRes] = await Promise.all([
          supabase
            .from("trade_lessons")
            .select("id")
            .eq("outcome", "loss")
            .contains("tags", [tickerBase])
            .gte("created_at", sevenDaysAgo),
          supabase
            .from("trade_lessons")
            .select("id")
            .eq("outcome", "win")
            .contains("tags", [tickerBase])
            .gte("created_at", sevenDaysAgo),
        ]);
        const isPattern    = (lossPatternRes.data?.length ?? 0) >= 2;
        const isWinPattern = (winPatternRes.data?.length  ?? 0) >= 3;
        const userFlaggedBad  = trade.user_rating === "bad";
        const userFlaggedGood = trade.user_rating === "good";
        const shouldPromote = llmShouldPromote || isPattern || isWinPattern
                            || absP >= 10 || userFlaggedBad || userFlaggedGood;

        if (shouldPromote) {
          // Memory content = the IF/THEN rule the qualify prompt should act on
          const memoryContent = do_differently;
          const memoryTitle = do_differently.slice(0, 80);
          const memoryTags = llmUsed
            ? [...new Set([trade.strategy_id?.toLowerCase(), lesson_type, outcome, tickerBase, ...llmMarketTags].filter(Boolean))]
            : [trade.strategy_id?.toLowerCase(), lesson_type, outcome, tickerBase].filter(Boolean);

          const { data: existingMem } = await supabase
            .from("agent_memory")
            .select("id, confirmations, confidence")
            .eq("is_active", true)
            .eq("memory_type", "lesson")
            .contains("tags", [tickerBase])
            .gte("created_at", sevenDaysAgo)
            .limit(1)
            .maybeSingle();

          if (existingMem) {
            await supabase.from("agent_memory").update({
              confirmations: (existingMem.confirmations || 1) + 1,
              // User-flagged trades get a stronger bump; good slightly less than bad (bad = avoid hard)
              confidence: Math.min(0.99, (existingMem.confidence || 0.85) + (userFlaggedBad ? 0.05 : userFlaggedGood ? 0.04 : 0.02)),
              // Update content with latest rule — LLM may have refined it
              ...(llmUsed ? { content: memoryContent, summary: memoryContent.slice(0, 120) } : {}),
              updated_at: new Date().toISOString(),
              last_updated_at: new Date().toISOString(),
            }).eq("id", existingMem.id);
          } else {
            await supabase.from("agent_memory").insert({
              memory_type: "lesson",
              title: memoryTitle,
              content: memoryContent,
              source_type: "trade_outcome",
              user_id: trade.user_id ?? null,
              strategy_id: trade.strategy_id,
              tags: [...memoryTags, ...(trade.user_rating ? ["user_rated", `user_${trade.user_rating}`] : [])],
              confidence: userFlaggedBad ? 0.90 : userFlaggedGood ? 0.88 : (outcome === "loss" ? 0.85 : 0.75),
              confirmations: 1,
              is_active: true,
              summary: memoryContent.slice(0, 120),
            });
          }
        }

        lessonsWritten++;
      }
    } catch (lessonErr) {
      const msg = lessonErr instanceof Error ? lessonErr.message : String(lessonErr);
      console.error("Lesson writing error:", msg);
      await supabase.from("compliance_log").insert({
        event_type: "lesson_write_error",
        severity: "error",
        message: `Lesson writing loop crashed: ${msg}`,
        metadata: { partial_results: results },
      }).then(undefined, () => {});
      // Lesson loop failure means trades aren't being learned from — alert on first occurrence.
      await alertOnce(supabase, "lesson_write_error", msg.slice(0, 60), 2,
        `⚠️ <b>[TradeAgent] Lesson Write Error</b>\nThe learning loop failed — trades are not being reflected into agent memory.\nError: ${msg.slice(0, 300)}`
      ).catch(() => {});
    }

    results.lessons_written = lessonsWritten;

    // ── 6. Memory Compaction ─────────────────────────────────────
    // Cooldown: only run if last compaction was >30 minutes ago.
    // Without this, auto-settle → auto-reflect → compact-memory chains
    // on every settlement batch, doubling LLM spend on high-volume days.
    let compactionResult: any = null;
    try {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recentCompaction } = await supabase
        .from("compliance_log")
        .select("id")
        .eq("event_type", "memory_compaction_run")
        .gte("created_at", thirtyMinAgo)
        .limit(1)
        .maybeSingle();

      if (!recentCompaction) {
        const compactResp = await fetch(
          `${supabaseUrl}/functions/v1/compact-memory`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          }
        );
        if (compactResp.ok) {
          compactionResult = await compactResp.json();
        }
      }
    } catch (e) {
      console.error("Compaction call failed:", e);
    }
    results.compaction = compactionResult;

    // ── 7. Backfill memory_attribution trade_pnl for settled trades ──
    try {
      const { data: unsettledAttributions } = await supabase
        .from("memory_attribution")
        .select("id, trade_id")
        .is("settled_at", null)
        .limit(100);

      if (unsettledAttributions && unsettledAttributions.length > 0) {
        for (const attr of unsettledAttributions) {
          const { data: trade } = await supabase
            .from("trades")
            .select("pnl, settled_at")
            .eq("id", attr.trade_id)
            .not("settled_at", "is", null)
            .single();

          if (trade) {
            await supabase.from("memory_attribution").update({
              trade_pnl: trade.pnl,
              settled_at: trade.settled_at,
            }).eq("id", attr.id);
          }
        }
      }
    } catch (backfillErr) {
      // Bayesian confidence scores depend on settled PnL — silent failure here corrupts the learning loop.
      const msg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
      console.error("memory_attribution backfill failed:", msg);
      await supabase.from("compliance_log").insert({
        event_type: "memory_attribution_backfill_error",
        severity: "error",
        message: `memory_attribution backfill failed: ${msg}`,
        metadata: { partial_results: results },
      }).then(undefined, () => {});
      await alertOnce(supabase, "memory_attribution_backfill_error", msg.slice(0, 60), 4,
        `⚠️ <b>[TradeAgent] Memory Attribution Backfill Failed</b>\nBayesian confidence scores will drift — settled PnL is not being linked to memory.\nError: ${msg.slice(0, 300)}`
      ).catch(() => {});
    }

    // ── 8. Log this run ──────────────────────────────────────────
    await supabase.from("compliance_log").insert({
      event_type: "auto_reflect_run",
      severity: "info",
      message: `Auto-reflect v2: ${memoriesUpdated} memories updated (Bayesian), ${memoriesQuarantined} quarantined, ${strategiesResumed} strategies resumed, ${lessonsWritten} lessons written, ${unreflectedCount} unreflected, ${signalsUpdated} signal outcomes linked, compaction: ${compactionResult?.summarized || 0} summarized`,
      metadata: results,
    });

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("auto-reflect error:", e);

    try {
      await supabase.from("compliance_log").insert({
        event_type: "auto_reflect_error",
        severity: "critical",
        message: `Auto-reflect v2 CRASHED: ${errMsg}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined, partial_results: results },
      });
    } catch { /* swallow — don't let the error handler throw */ }

    // Agent memory and learning loop is stopped until this is fixed. Must alert immediately.
    await sendTelegramAlert(
      `🚨 <b>[TradeAgent] auto-reflect CRASHED</b>\n` +
      `The learning loop is stopped — memory updates, lessons, and strategy health checks are not running.\n` +
      `Error: ${errMsg.slice(0, 300)}`
    ).catch(() => {});

    return new Response(
      JSON.stringify({ error: errMsg, partial_results: results }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
