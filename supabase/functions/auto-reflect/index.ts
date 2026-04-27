import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

/**
 * auto-reflect: Automated learning loop that runs on a schedule.
 *
 * 1. P&L-based confidence: updates memory confidence based on linked trade outcomes
 * 2. Strategy auto-disable: deactivates strategies with sustained negative ROI
 * 3. Unreflected trade analysis: marks stale trades so next agent session reflects
 *
 * Triggered by pg_cron every hour (see migration).
 * Can also be called manually via POST.
 */


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
    // ── 1. P&L-Based Confidence Updates ──────────────────────────
    // Find memories linked to trades that now have P&L data.
    // If linked trades are profitable on average → boost confidence.
    // If linked trades are unprofitable → reduce confidence.

    const { data: activeMemories } = await supabase
      .from("agent_memory")
      .select("id, title, confidence, confirmations, contradictions, related_trade_ids, strategy_id, updated_at")
      .eq("is_active", true)
      .not("related_trade_ids", "eq", "{}");

    let memoriesConfirmed = 0;
    let memoriesContradicted = 0;

    for (const mem of activeMemories || []) {
      const tradeIds = mem.related_trade_ids || [];
      if (tradeIds.length === 0) continue;

      // Get P&L for linked trades
      const { data: linkedTrades } = await supabase
        .from("trades")
        .select("id, pnl, status")
        .in("id", tradeIds)
        .eq("status", "filled");

      if (!linkedTrades || linkedTrades.length === 0) continue;

      const totalPnl = linkedTrades.reduce((sum: number, t: any) => sum + (Number(t.pnl) || 0), 0);
      const avgPnl = totalPnl / linkedTrades.length;

      // Skip if all trades have 0 P&L (not yet resolved)
      const hasRealPnl = linkedTrades.some((t: any) => (Number(t.pnl) || 0) !== 0);
      if (!hasRealPnl) continue;

      // Don't re-process if memory was updated in the last hour
      const lastUpdate = new Date(mem.updated_at).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (lastUpdate > oneHourAgo) continue;

      const updates: any = { updated_at: new Date().toISOString() };

      if (avgPnl > 0) {
        // Profitable → confirm (boost by 5% for auto, smaller than manual 10%)
        updates.confirmations = (mem.confirmations || 0) + 1;
        updates.confidence = Math.min(0.95, (mem.confidence || 0.5) + 0.05);
        memoriesConfirmed++;
      } else if (avgPnl < 0) {
        // Unprofitable → contradict (reduce by 10% for auto, smaller than manual 15%)
        updates.contradictions = (mem.contradictions || 0) + 1;
        updates.confidence = Math.max(0.05, (mem.confidence || 0.5) - 0.10);
        if (updates.confidence < 0.15) {
          await supabase.from("compliance_log").insert({
            event_type: "memory_low_confidence",
            severity: "warning",
            message: `Memory low confidence: "${mem.title}" — ${(updates.confidence * 100).toFixed(0)}% after unprofitable linked trades (avg P&L: $${avgPnl.toFixed(2)}). Kept active to accumulate platform-wide evidence.`,
            metadata: {
              memory_id: mem.id,
              memory_type: mem.memory_type,
              current_confidence: updates.confidence,
              contradictions: updates.contradictions,
              avg_pnl: avgPnl,
              related_trade_ids: mem.related_trade_ids,
            },
          });
        }
        memoriesContradicted++;
      }

      await supabase.from("agent_memory").update(updates).eq("id", mem.id);
    }

    results.pnl_confidence = {
      memories_checked: (activeMemories || []).length,
      confirmed: memoriesConfirmed,
      contradicted: memoriesContradicted,
    };

    // ── 2. Strategy Health Monitor ───────────────────────────────
    // Evaluates consecutive losses from the most recent trade backward.
    // Never hard-disables — uses a suspended_until cooldown instead so
    // strategies auto-resume and the system stays symmetric.
    //
    // Thresholds:
    //   3  consecutive losses → warning + cautionary memory (correction hint)
    //   10 consecutive losses → flag underperforming, 24h suspension
    //   15 consecutive losses → flag critical, 72h suspension
    //
    // Auto-re-enable: inactive strategies past their suspended_until are
    // re-activated here so the system can self-correct.

    const { data: strategies } = await supabase
      .from("strategies")
      .select("id, name, active, starting_balance, mode, suspended_until, updated_at");

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
        updated_at: now.toISOString(),
      }).eq("id", strat.id);

      await supabase.from("compliance_log").insert({
        event_type: "strategy_resumed",
        severity: "info",
        message: `Strategy "${strat.name}" auto-resumed after suspension window ended.`,
        metadata: { strategy_id: strat.id, suspended_until: strat.suspended_until },
      });

      strategiesResumed++;
    }

    // ── 2b. Evaluate active strategies for consecutive losses ──
    const activeStrategies = (strategies || []).filter((s: any) => s.active);

    for (const strat of activeStrategies) {
      // Fetch recent trades ordered oldest→newest so we can count from the end
      const { data: rawTrades } = await supabase
        .from("trades")
        .select("pnl, status, created_at")
        .eq("status", "filled")
        .or(`strategy_id.eq.${strat.id},strategy.eq.${strat.name}`)
        .order("created_at", { ascending: true });

      if (!rawTrades || rawTrades.length === 0) {
        strategyResults.push({ id: strat.id, name: strat.name, trades: 0, action: "skipped", reason: "no trades yet" });
        continue;
      }

      // Count consecutive losses from the most recent trade backward
      let consecutiveLosses = 0;
      for (let i = rawTrades.length - 1; i >= 0; i--) {
        if ((Number(rawTrades[i].pnl) || 0) < 0) consecutiveLosses++;
        else break;
      }

      const totalPnl = rawTrades.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0);
      const winRate = rawTrades.filter((t: any) => (Number(t.pnl) || 0) > 0).length / rawTrades.length;
      const tag = strat.name.toLowerCase().replace(/\s+/g, "_");

      if (consecutiveLosses >= 15) {
        // Critical — 72h suspension, flag for human review
        const suspendUntil = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies").update({
          active: false,
          suspended_until: suspendUntil,
          updated_at: now.toISOString(),
        }).eq("id", strat.id);

        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended_critical",
          severity: "critical",
          message: `Strategy "${strat.name}" suspended 72h — ${consecutiveLosses} consecutive losses. Total P&L: $${totalPnl.toFixed(2)}, win rate: ${(winRate * 100).toFixed(0)}%. Human review required.`,
          metadata: { strategy_id: strat.id, consecutiveLosses, totalPnl, winRate, tradeCount: rawTrades.length, suspended_until: suspendUntil },
        });

        await supabase.from("agent_memory").insert({
          memory_type: "strategy_insight",
          title: `"${strat.name}" suspended — ${consecutiveLosses} consecutive losses`,
          content: `Suspended 72h after ${consecutiveLosses} consecutive losses (${rawTrades.length} total trades, win rate ${(winRate * 100).toFixed(0)}%, P&L $${totalPnl.toFixed(2)}). Auto-resumes after suspension but requires investigation before scaling.`,
          source_type: "reflection",
          tags: ["suspended", "critical", tag],
          strategy_id: strat.id,
          confidence: 0.9,
        });

        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "suspended_72h" });

      } else if (consecutiveLosses >= 10) {
        // Underperforming — 24h suspension
        const suspendUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        await supabase.from("strategies").update({
          active: false,
          suspended_until: suspendUntil,
          updated_at: now.toISOString(),
        }).eq("id", strat.id);

        await supabase.from("compliance_log").insert({
          event_type: "strategy_suspended",
          severity: "warning",
          message: `Strategy "${strat.name}" suspended 24h — ${consecutiveLosses} consecutive losses. P&L: $${totalPnl.toFixed(2)}.`,
          metadata: { strategy_id: strat.id, consecutiveLosses, totalPnl, winRate, tradeCount: rawTrades.length, suspended_until: suspendUntil },
        });

        await supabase.from("agent_memory").insert({
          memory_type: "strategy_insight",
          title: `"${strat.name}" suspended — ${consecutiveLosses} consecutive losses`,
          content: `Suspended 24h after ${consecutiveLosses} consecutive losses. Win rate ${(winRate * 100).toFixed(0)}%, P&L $${totalPnl.toFixed(2)}. Reduce position size on resume until streak resets.`,
          source_type: "reflection",
          tags: ["suspended", "underperforming", tag],
          strategy_id: strat.id,
          confidence: 0.8,
        });

        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "suspended_24h" });

      } else if (consecutiveLosses >= 3) {
        // Warning — stay active, save cautionary memory as correction signal
        await supabase.from("compliance_log").insert({
          event_type: "strategy_loss_streak",
          severity: "warning",
          message: `Strategy "${strat.name}" — ${consecutiveLosses} consecutive losses. Still active. Monitor closely.`,
          metadata: { strategy_id: strat.id, consecutiveLosses, totalPnl, winRate, tradeCount: rawTrades.length },
        });

        await supabase.from("agent_memory").insert({
          memory_type: "strategy_insight",
          title: `"${strat.name}" on ${consecutiveLosses}-loss streak — trade cautiously`,
          content: `${consecutiveLosses} consecutive losses as of last evaluation. Reduce position size or skip marginal signals until a win resets the streak. Win rate overall: ${(winRate * 100).toFixed(0)}%.`,
          source_type: "reflection",
          tags: ["loss_streak", "caution", tag],
          strategy_id: strat.id,
          confidence: 0.7,
        });

        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "warned" });

      } else {
        strategyResults.push({ id: strat.id, name: strat.name, consecutiveLosses, action: "healthy" });
      }
    }

    results.strategy_review = {
      strategies_checked: (strategies || []).length,
      active_evaluated: activeStrategies.length,
      resumed: strategiesResumed,
      details: strategyResults,
    };

    // ── 3. Unreflected Trade Count ───────────────────────────────
    // Count trades that haven't been reflected on — the agent
    // will see this in its system prompt next session.

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

    // ── 4. Signal Quality Feedback ───────────────────────────────
    // Match acted-on signals to their trade outcomes.
    // Updates signal rows with outcome_pnl and outcome_correct.

    let signalsEvaluated = 0;
    let signalsCorrect = 0;
    let signalsWrong = 0;

    try {
      // Find signals that WERE acted on but outcome_correct not yet set
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: unevaluatedSignals } = await supabase
        .from("signals")
        .select("id, ticker, direction, mid_price, created_at")
        .eq("was_acted_on", true)
        .is("outcome_correct", null)
        .gte("created_at", sevenDaysAgo);

      for (const signal of unevaluatedSignals || []) {
        // Look for a trade on the same ticker placed within 2 hours of the signal
        const signalTime = new Date(signal.created_at).getTime();
        const windowStart = new Date(signalTime - 2 * 60 * 60 * 1000).toISOString();
        const windowEnd = new Date(signalTime + 2 * 60 * 60 * 1000).toISOString();

        const { data: matchedTrades } = await supabase
          .from("trades")
          .select("id, pnl, side, action, status")
          .eq("ticker", signal.ticker)
          .eq("status", "filled")
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)
          .limit(1);

        if (!matchedTrades || matchedTrades.length === 0) continue;

        const trade = matchedTrades[0];
        const pnl = Number(trade.pnl) || 0;

        // Determine if signal direction matched trade and was profitable
        const signalSide = signal.direction === "buy_yes" ? "yes" : "no";
        const directionMatch = trade.side === signalSide && trade.action === "buy";
        const wasCorrect = directionMatch && pnl > 0;

        await supabase.from("signals").update({
          was_acted_on: true,
          outcome_pnl: pnl,
          outcome_correct: wasCorrect,
        }).eq("id", signal.id);

        signalsEvaluated++;
        if (wasCorrect) signalsCorrect++;
        else signalsWrong++;
      }
    } catch (signalErr) {
      console.error("Signal quality tracking error:", signalErr);
    }

    results.signal_quality = {
      evaluated: signalsEvaluated,
      correct: signalsCorrect,
      wrong: signalsWrong,
      accuracy: signalsEvaluated > 0
        ? `${((signalsCorrect / signalsEvaluated) * 100).toFixed(0)}%`
        : "n/a",
    };

    // ── 5. Write Lessons from Recently Settled Trades ────────────
    // For every trade settled in the last 24h with real PnL and no lesson yet,
    // classify the outcome and write a trade_lesson + update agent_memory.
    // Rule-based classification — no LLM needed here.

    let lessonsWritten = 0;
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Trades settled recently with real PnL
      const { data: recentSettled } = await supabase
        .from("trades")
        .select("id, strategy_id, ticker, side, price, pnl, resolution, notes, created_at, settled_at")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .neq("pnl", 0)
        .gte("settled_at", oneDayAgo);

      // Find which trade IDs already have lessons
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
            // Extreme price — market had already decided
            lesson_type = "signal_quality";
            lesson = `Entered at ${price}¢ on ${trade.ticker}. A price below 10¢ or above 90¢ means the market has already priced the outcome. This is not an edge — it is fighting a resolved market. Lost $${Math.abs(pnl).toFixed(2)}.`;
            do_differently = "Enforce mid_price 10–90¢ filter at signal creation time, not just in the query.";
          } else if (notes.includes("true_p=")) {
            // S-005: extract model vs market divergence from notes
            const truePMatch = notes.match(/true_p=([\d.]+)/);
            const trueP = truePMatch ? parseFloat(truePMatch[1]) : null;
            if (trueP !== null && (trueP > 0.7 || trueP < 0.3)) {
              const impliedFromPrice = price / 100;
              const divergence = Math.abs(trueP - impliedFromPrice);
              if (divergence > 0.5) {
                lesson_type = "forecast_bias";
                lesson = `GFS model said ${(trueP * 100).toFixed(0)}%, market priced ${price}¢ (${(impliedFromPrice * 100).toFixed(0)}%). Divergence ${(divergence * 100).toFixed(0)}pp — market was right. Lost $${Math.abs(pnl).toFixed(2)}.`;
                do_differently = "When model-market divergence exceeds 50pp, the market has more timely NWS/observational data. Skip or wait for next GFS cycle.";
              }
            }
            if (!lesson) {
              lesson_type = "forecast_bias";
              lesson = `S-005 loss on ${trade.ticker} at ${price}¢. Model confidence did not match outcome. Lost $${Math.abs(pnl).toFixed(2)}.`;
              do_differently = "Review GFS calibration for this city and season.";
            }
          } else {
            lesson_type = "market_timing";
            lesson = `Loss on ${trade.ticker}: bought ${trade.side} at ${price}¢, resolved ${trade.resolution?.toUpperCase()}. Lost $${Math.abs(pnl).toFixed(2)}.`;
            do_differently = "Review signal source and entry conditions for this market type.";
          }
        } else {
          // Win — record what worked
          lesson_type = "general";
          lesson = `Win on ${trade.ticker}: bought ${trade.side} at ${price}¢, resolved ${trade.resolution?.toUpperCase()}. Profit $${pnl.toFixed(2)}.`;
          do_differently = "Continue this pattern.";
        }

        // Valid lesson_type values: 'forecast_bias', 'market_timing', 'signal_quality', 'execution', 'market_structure', 'general'
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

        // Link lesson back to trade_reflections so the loop is closed
        if (insertedLesson?.id) {
          await supabase
            .from("trade_reflections")
            .update({ lesson_id: insertedLesson.id })
            .eq("trade_id", trade.id);
        }

        // Promote losses at extreme prices or high-magnitude PnL to agent_memory
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
    // Call compact-memory to summarize and merge related memories
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

    // ── 6. Log this run ──────────────────────────────────────────
    await supabase.from("compliance_log").insert({
      event_type: "auto_reflect_run",
      severity: "info",
      message: `Auto-reflect: ${memoriesConfirmed} memories confirmed, ${memoriesContradicted} contradicted, ${strategiesResumed} strategies resumed, ${lessonsWritten} lessons written, ${unreflectedCount} unreflected, signals evaluated: ${signalsEvaluated} (${signalsCorrect} correct), compaction: ${compactionResult?.summarized || 0} summarized`,
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
        message: `Auto-reflect failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined, partial_results: results },
      });
    } catch {}

    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error", partial_results: results }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
