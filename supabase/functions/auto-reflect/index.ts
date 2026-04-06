import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
    let memoriesDeactivated = 0;

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
          updates.is_active = false;
          memoriesDeactivated++;
        }
        memoriesContradicted++;
      }

      await supabase.from("agent_memory").update(updates).eq("id", mem.id);
    }

    results.pnl_confidence = {
      memories_checked: (activeMemories || []).length,
      confirmed: memoriesConfirmed,
      contradicted: memoriesContradicted,
      deactivated: memoriesDeactivated,
    };

    // ── 2. Strategy Auto-Disable ─────────────────────────────────
    // Check each active strategy's ROI. If ROI is negative after
    // a meaningful number of trades, auto-deactivate it.

    const { data: strategies } = await supabase
      .from("strategies")
      .select("id, name, active, starting_balance, mode")
      .eq("active", true);

    let strategiesDisabled = 0;
    const strategyResults: any[] = [];

    for (const strat of strategies || []) {
      const { data: stratTrades } = await supabase
        .from("trades")
        .select("pnl, status")
        .eq("status", "filled")
        .or(`strategy_id.eq.${strat.id},strategy.eq.${strat.name}`);

      if (!stratTrades || stratTrades.length < 5) {
        // Need at least 5 trades to evaluate
        strategyResults.push({
          id: strat.id, name: strat.name, trades: stratTrades?.length || 0,
          action: "skipped", reason: "insufficient trades (need 5+)",
        });
        continue;
      }

      const totalPnl = stratTrades.reduce((sum: number, t: any) => sum + (Number(t.pnl) || 0), 0);
      const roi = strat.starting_balance > 0
        ? (totalPnl / strat.starting_balance) * 100
        : 0;
      const winRate = stratTrades.filter((t: any) => (Number(t.pnl) || 0) > 0).length / stratTrades.length;

      // Auto-disable if: ROI < -10% OR (ROI negative AND win rate < 30%)
      const shouldDisable = roi < -10 || (roi < 0 && winRate < 0.30);

      if (shouldDisable) {
        await supabase.from("strategies").update({
          active: false,
          updated_at: new Date().toISOString(),
        }).eq("id", strat.id);

        // Save a memory about why the strategy was disabled
        await supabase.from("agent_memory").insert({
          memory_type: "strategy_insight",
          title: `Strategy "${strat.name}" auto-disabled due to poor performance`,
          content: `Auto-disabled after ${stratTrades.length} trades. ROI: ${roi.toFixed(1)}%, Win rate: ${(winRate * 100).toFixed(0)}%, Total P&L: $${totalPnl.toFixed(2)}. The strategy needs review before re-enabling.`,
          source_type: "reflection",
          tags: ["auto-disable", "performance", strat.name.toLowerCase().replace(/\s+/g, "_")],
          strategy_id: strat.id,
          confidence: 0.8,
        });

        // Log to compliance
        await supabase.from("compliance_log").insert({
          event_type: "strategy_auto_disabled",
          severity: "warning",
          message: `Strategy "${strat.name}" (${strat.id}) auto-disabled: ROI ${roi.toFixed(1)}%, win rate ${(winRate * 100).toFixed(0)}%`,
          metadata: { strategy_id: strat.id, roi, winRate, totalPnl, tradeCount: stratTrades.length },
        });

        strategiesDisabled++;
        strategyResults.push({
          id: strat.id, name: strat.name, trades: stratTrades.length,
          roi: `${roi.toFixed(1)}%`, winRate: `${(winRate * 100).toFixed(0)}%`,
          totalPnl: totalPnl.toFixed(2), action: "disabled",
        });
      } else {
        strategyResults.push({
          id: strat.id, name: strat.name, trades: stratTrades.length,
          roi: `${roi.toFixed(1)}%`, winRate: `${(winRate * 100).toFixed(0)}%`,
          totalPnl: totalPnl.toFixed(2), action: "kept_active",
        });
      }
    }

    results.strategy_review = {
      strategies_checked: (strategies || []).length,
      disabled: strategiesDisabled,
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

    // ── 4. Memory Compaction ─────────────────────────────────────
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

    // ── 5. Log this run ──────────────────────────────────────────
    await supabase.from("compliance_log").insert({
      event_type: "auto_reflect_run",
      severity: "info",
      message: `Auto-reflect completed: ${memoriesConfirmed} confirmed, ${memoriesContradicted} contradicted, ${memoriesDeactivated} deactivated, ${strategiesDisabled} strategies disabled, ${unreflectedCount} unreflected trades, compaction: ${compactionResult?.summarized || 0} summarized / ${compactionResult?.merged || 0} merged`,
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
