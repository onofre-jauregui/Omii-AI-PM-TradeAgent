import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

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
    // Consecutive losses remain as a soft warning only (5+ losses).

    const { data: strategies } = await supabase
      .from("strategies")
      .select("id, name, active, starting_balance, mode, suspended_until, updated_at, expected_hit_rate, max_acceptable_drawdown, suspension_reason");

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
        // Soft warning only
        await supabase.from("compliance_log").insert({
          event_type: "strategy_loss_streak",
          severity: "warning",
          message: `Strategy "${strat.name}" — ${consecutiveLosses} consecutive losses (soft signal). Sharpe: ${sharpe.toFixed(2)}, drawdown: ${(maxDdPct * 100).toFixed(1)}%.`,
          metadata: { strategy_id: strat.id, consecutiveLosses, sharpe, max_drawdown: maxDdPct, hit_rate: hitRate },
        });

        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "warned" });

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
    // 6-hour rolling window (tightened from 24h for faster feedback).

    let lessonsWritten = 0;
    try {
      const windowAgo = new Date(Date.now() - LESSON_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

      const { data: recentSettled } = await supabase
        .from("trades")
        .select("id, strategy_id, ticker, side, price, pnl, resolution, notes, settled_at")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .neq("pnl", 0)
        .gte("settled_at", windowAgo);

      const settledIds = (recentSettled || []).map((t: any) => t.id);
      const existingLessons = settledIds.length > 0
        ? (await supabase.from("trade_lessons").select("trade_id").in("trade_id", settledIds)).data || []
        : [];
      const alreadyLearned = new Set(existingLessons.map((r: any) => r.trade_id));

      for (const trade of (recentSettled || [])) {
        if (alreadyLearned.has(trade.id)) continue;

        const pnl = Number(trade.pnl);
        const price = Number(trade.price);
        const outcome = pnl > 0 ? "win" : "loss";
        const notes = trade.notes || "";

        let lesson_type = "general";
        let lesson = "";
        let do_differently = "";

        if (outcome === "loss") {
          if (price < 10 || price > 90) {
            lesson_type = "signal_quality";
            lesson = `Entered at ${price}¢ on ${trade.ticker}. Market already priced — not an edge. Lost $${Math.abs(pnl).toFixed(2)}.`;
            do_differently = "Enforce mid_price 10–90¢ filter at signal creation time.";
          } else if (notes.includes("true_p=")) {
            const truePMatch = notes.match(/true_p=([\d.]+)/);
            const trueP = truePMatch ? parseFloat(truePMatch[1]) : null;
            if (trueP !== null) {
              const impliedFromPrice = price / 100;
              const divergence = Math.abs(trueP - impliedFromPrice);
              if (divergence > 0.5) {
                lesson_type = "forecast_bias";
                lesson = `GFS model said ${(trueP * 100).toFixed(0)}%, market priced ${price}¢. Divergence ${(divergence * 100).toFixed(0)}pp — market was right. Lost $${Math.abs(pnl).toFixed(2)}.`;
                do_differently = "When divergence exceeds 50pp, skip or wait for next GFS cycle.";
              }
            }
            if (!lesson) {
              lesson_type = "forecast_bias";
              lesson = `S-005 loss on ${trade.ticker} at ${price}¢. Model didn't match outcome. Lost $${Math.abs(pnl).toFixed(2)}.`;
              do_differently = "Review GFS calibration for this city/season.";
            }
          } else {
            lesson_type = "market_timing";
            lesson = `Loss on ${trade.ticker}: bought ${trade.side} at ${price}¢. Lost $${Math.abs(pnl).toFixed(2)}.`;
            do_differently = "Review signal source and entry conditions.";
          }
        } else {
          lesson_type = "general";
          lesson = `Win on ${trade.ticker}: bought ${trade.side} at ${price}¢. Profit $${pnl.toFixed(2)}.`;
          do_differently = "Continue this pattern.";
        }

        const validTypes = ["forecast_bias", "market_timing", "signal_quality", "execution", "market_structure", "general"];
        if (!validTypes.includes(lesson_type)) lesson_type = "general";

        const { data: insertedLesson } = await supabase
          .from("trade_lessons")
          .insert({
            trade_id: trade.id,
            ticker: trade.ticker,
            strategy_id: trade.strategy_id,
            outcome,
            lesson_type,
            lesson,
            do_differently,
            confidence: 0.8,
            tags: [trade.strategy_id?.toLowerCase(), lesson_type, outcome].filter(Boolean),
            trade_context: { price, pnl, resolution: trade.resolution, notes: notes.slice(0, 200) },
          })
          .select("id")
          .single();

        if (insertedLesson?.id) {
          await supabase
            .from("trade_reflections")
            .update({ lesson_id: insertedLesson.id })
            .eq("trade_id", trade.id);
        }

        // Promote significant outcomes to agent_memory
        const absP = Math.abs(pnl);
        const shouldPromote = (outcome === "loss" && (price < 10 || price > 85)) || absP >= 50;
        if (shouldPromote) {
          await supabase.from("agent_memory").insert({
            memory_type: "lesson",
            title: `${outcome === "loss" ? "Loss" : "Win"} on ${trade.ticker} at ${price}¢ — ${lesson_type}`,
            content: `${lesson} ${do_differently}`,
            source_type: "trade_outcome",
            strategy_id: trade.strategy_id,
            tags: [trade.strategy_id?.toLowerCase(), lesson_type, outcome, trade.ticker.split("-")[0].toLowerCase()].filter(Boolean),
            confidence: outcome === "loss" ? 0.85 : 0.75,
            confirmations: 1,
            is_active: true,
            summary: lesson.slice(0, 120),
          });
        }

        lessonsWritten++;
      }
    } catch (lessonErr) {
      console.error("Lesson writing error:", lessonErr);
    }

    results.lessons_written = lessonsWritten;

    // ── 6. Memory Compaction ─────────────────────────────────────
    let compactionResult: any = null;
    try {
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
    } catch {}

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
    console.error("auto-reflect error:", e);

    try {
      await supabase.from("compliance_log").insert({
        event_type: "auto_reflect_error",
        severity: "error",
        message: `Auto-reflect v2 failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined, partial_results: results },
      });
    } catch {}

    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error", partial_results: results }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
