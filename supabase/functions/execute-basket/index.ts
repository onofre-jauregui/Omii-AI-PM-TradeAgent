import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { resolveTenant, tenantInsertFields, getRiskSettings } from "../_shared/tenant.ts";
import { evaluateCapitalCap } from "../_shared/risk.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";
import { determineBasketStatus, resolveFlattenOutcome } from "../_shared/basket-logic.ts";

/**
 * execute-basket: Multi-leg ordered trade execution with stateful lifecycle.
 *
 * Solves the core problem with surface arbitrage: you can't submit two
 * independent orders and hope both fill. If leg 1 fills and leg 2 doesn't,
 * you have naked directional exposure.
 *
 * This function:
 *  1. Creates a basket record tracking the whole operation
 *  2. Executes legs in priority order (most fragile / thinnest first)
 *  3. After each fill, re-evaluates whether remaining edge justifies continuing
 *  4. If edge has degraded or a leg fails: flattens any filled legs and aborts
 *  5. Times out and flattens if the basket isn't complete within N seconds
 *
 * Basket state machine:
 *   pending → executing → completed | aborted | timed_out | partially_filled
 *
 * Leg state machine:
 *   pending → submitted → filled | failed | cancelled
 */

// How long to wait for all legs to fill before aborting and flattening
const BASKET_TIMEOUT_MS = 30_000; // 30 seconds
// Minimum remaining edge (cents) after first leg fills to continue
const MIN_POST_FILL_EDGE_CENTS = 2;

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

  try {
    const body = await req.json();
    const tenant = await resolveTenant(req, supabase, body);

    const {
      strategy_id,
      strategy_name,
      alert_id,          // surface_alerts.id that triggered this basket (optional)
      legs,              // array of leg specs (see LegSpec type below)
      mode = "paper",
      expected_edge_cents = 0,
      reasoning = "",
    } = body;

    // ── Capital allocation guard (live trades only) ───────────────────────────
    // Prevent the agent from deploying more than the user's configured cap.
    // Paper trades bypass this check — no real money at risk.
    if (mode === "live" && tenant.userId) {
      // Use the shared, mode-scoped reader — a user_id-only query matches both
      // the paper and live rows and silently falls back to the $500 default.
      const riskRow = await getRiskSettings(supabase, tenant.userId, "live");

      const cap: number = riskRow?.allocated_capital ?? 500;

      // Open live exposure = live trades still holding risk (not yet settled).
      // Broadened from status='open' only to filled/open/partial to match the
      // per-leg cap in execute-trade — otherwise filled legs wouldn't count.
      const { data: openTrades } = await supabase
        .from("trades")
        .select("amount")
        .eq("user_id", tenant.userId)
        .eq("mode", "live")
        .in("status", ["filled", "open", "partial"])
        .is("settled_at", null);

      const openExposure: number = (openTrades ?? []).reduce(
        (sum: number, t: { amount: number }) => sum + (t.amount ?? 0),
        0
      );

      // Sum cost of every leg in this incoming basket
      const basketCost: number = legs.reduce(
        (sum: number, l: { amount: number }) => sum + (l.amount ?? 0),
        0
      );

      const capCheck = evaluateCapitalCap(openExposure, basketCost, cap);
      if (!capCheck.passed) {
        return new Response(
          JSON.stringify({ error: capCheck.reason, code: "CAPITAL_CAP_EXCEEDED" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!legs || !Array.isArray(legs) || legs.length < 2) {
      return new Response(JSON.stringify({ error: "legs must be an array of 2 or more leg specs" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const leg of legs) {
      if (!leg.ticker || !leg.side || !leg.action || !leg.price || !leg.amount) {
        return new Response(JSON.stringify({ error: `Leg missing required fields: ${JSON.stringify(leg)}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Create basket record ──────────────────────────────────────────────────
    const { data: basket, error: basketErr } = await supabase
      .from("baskets")
      .insert({
        ...tenantInsertFields(tenant.userId),
        strategy_id: strategy_id || null,
        strategy_name: strategy_name || null,
        alert_id: alert_id || null,
        mode,
        status: "executing",
        leg_count: legs.length,
        legs_filled: 0,
        expected_edge_cents,
        reasoning,
        started_at: new Date().toISOString(),
        timeout_at: new Date(Date.now() + BASKET_TIMEOUT_MS).toISOString(),
      })
      .select()
      .single();

    if (basketErr || !basket) {
      throw new Error(`Failed to create basket: ${basketErr?.message || "unknown"}`);
    }

    const basketId = basket.id;
    const executeUrl = `${supabaseUrl}/functions/v1/execute-trade`;
    const filledTradeIds: string[] = [];
    const legResults: any[] = [];

    let currentEdgeCents = expected_edge_cents;
    let abortReason: string | null = null;
    const startMs = Date.now();

    // ── Execute legs in order ─────────────────────────────────────────────────
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];

      // Check timeout
      if (Date.now() - startMs > BASKET_TIMEOUT_MS) {
        abortReason = `Basket timed out after ${BASKET_TIMEOUT_MS / 1000}s`;
        break;
      }

      // After first leg fills, re-check edge is still worth it
      if (i > 0 && currentEdgeCents < MIN_POST_FILL_EDGE_CENTS) {
        abortReason = `Remaining edge (${currentEdgeCents}¢) below minimum (${MIN_POST_FILL_EDGE_CENTS}¢) after leg ${i} filled`;
        break;
      }

      try {
        const legResp = await fetch(executeUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ticker: leg.ticker,
            marketId: leg.ticker,
            marketQuestion: leg.market_question || leg.ticker,
            side: leg.side,
            action: leg.action,
            price: leg.price,
            amount: leg.amount,
            strategy: strategy_name || null,
            strategyId: strategy_id || null,
            orderType: leg.order_type || "limit",
            mode,
            notes: `Basket ${basketId} leg ${i + 1}/${legs.length}: ${reasoning}`,
            basketId,
          }),
        });

        const legResult = await legResp.json();
        legResults.push({ leg_index: i, ...legResult });

        if (legResult.success) {
          filledTradeIds.push(legResult.trade?.id);

          // Update basket progress
          await supabase.from("baskets").update({
            legs_filled: i + 1,
            updated_at: new Date().toISOString(),
          }).eq("id", basketId);

          // Link trade to basket
          if (legResult.trade?.id) {
            await supabase.from("trades").update({
              basket_id: basketId,
            }).eq("id", legResult.trade.id);
          }

          // After first leg fills, recalculate remaining edge:
          // The filled price may differ from expected → update edge estimate
          if (i === 0 && legResult.trade?.filled_price) {
            const priceDiff = Math.abs(legResult.trade.filled_price - leg.price);
            currentEdgeCents = Math.max(0, currentEdgeCents - priceDiff);
          }
        } else {
          // Leg failed — abort and flatten
          abortReason = `Leg ${i + 1} failed: ${legResult.error || "execution error"}`;
          break;
        }
      } catch (legErr) {
        abortReason = `Leg ${i + 1} threw: ${legErr instanceof Error ? legErr.message : "unknown"}`;
        break;
      }
    }

    // ── Determine final basket status ─────────────────────────────────────────
    let finalStatus = determineBasketStatus(legResults, legs.length, filledTradeIds.length, abortReason);

    // ── Flatten partially filled legs if basket didn't complete ───────────────
    // A basket is only "flattened" if every filled leg's closing order actually
    // succeeded — previously `finalStatus` flipped to "flattened" whenever
    // flattenResults was non-empty, which included entries for FAILED flatten
    // attempts (execute-trade returning success:false, or the fetch throwing).
    // That meant a basket left with real naked live exposure could be reported
    // as safely resolved. resolveFlattenOutcome only claims "flattened" when
    // the fill count matches; otherwise the original (honest) status is kept
    // and this alerts loudly, because that's the one state that needs a human
    // to manually close the position.
    let flattenResults: any[] = [];
    if (finalStatus !== "completed" && filledTradeIds.length > 0) {
      flattenResults = await flattenFilledLegs(
        supabase,
        executeUrl,
        supabaseKey,
        legs,
        legResults,
        basketId,
        strategy_id,
        strategy_name,
        mode
      );
      const outcome = resolveFlattenOutcome(flattenResults, filledTradeIds.length);
      if (outcome === "flattened") {
        finalStatus = "flattened";
      } else if (outcome === "flatten_failed") {
        const flattenedCount = flattenResults.filter(r => r.success).length;
        const failedCount = flattenResults.length - flattenedCount;
        const alertMsg = `🔴 BASKET FLATTEN FAILED — basket ${basketId} (${mode}): ${failedCount}/${flattenResults.length} flatten attempt(s) failed. ${filledTradeIds.length} filled leg(s) may still hold naked exposure. Manual review required.`;
        console.error(alertMsg);
        await supabase.from("compliance_log").insert({
          event_type: "basket_flatten_failed",
          severity: "critical",
          message: alertMsg,
          metadata: { basket_id: basketId, mode, filled_legs: filledTradeIds.length, flatten_attempted: flattenResults.length, flatten_succeeded: flattenedCount },
        });
        if (mode === "live") await sendTelegramAlert(alertMsg);
      }
    }

    // ── Update basket to final state ──────────────────────────────────────────
    await supabase.from("baskets").update({
      status: finalStatus,
      abort_reason: abortReason,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", basketId);

    // ── Mark alert as exploited if basket completed ───────────────────────────
    if (finalStatus === "completed" && alert_id) {
      await supabase.from("surface_alerts").update({
        is_exploited: true,
        exploited_at: new Date().toISOString(),
        exploited_by_trade_id: filledTradeIds[0] || null,
      }).eq("id", alert_id);
    }

    // ── Compliance log ────────────────────────────────────────────────────────
    await supabase.from("compliance_log").insert({
      event_type: finalStatus === "completed" ? "basket_completed" : "basket_aborted",
      severity: finalStatus === "completed" ? "info" : "warning",
      message: `Basket ${basketId} ${finalStatus}: ${legs.length} legs, ${filledTradeIds.length} filled${abortReason ? `. Reason: ${abortReason}` : ""}`,
      metadata: {
        basket_id: basketId,
        final_status: finalStatus,
        legs_attempted: legs.length,
        legs_filled: filledTradeIds.length,
        expected_edge_cents,
        abort_reason: abortReason,
        flatten_count: flattenResults.length,
      },
    });

    return new Response(JSON.stringify({
      success: finalStatus === "completed",
      basket_id: basketId,
      status: finalStatus,
      legs_filled: filledTradeIds.length,
      legs_total: legs.length,
      abort_reason: abortReason,
      leg_results: legResults,
      flatten_results: flattenResults,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("execute-basket error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ─── Flatten Helper ───────────────────────────────────────────────────────────
// If a basket is partially filled and can't complete, we close filled legs
// by submitting the opposite side to eliminate directional exposure.

async function flattenFilledLegs(
  supabase: any,
  executeUrl: string,
  supabaseKey: string,
  legs: any[],
  legResults: any[],
  basketId: string,
  strategyId: string | null,
  strategyName: string | null,
  mode: string
): Promise<any[]> {
  const flattenResults: any[] = [];

  for (let i = 0; i < legResults.length; i++) {
    const result = legResults[i];
    if (!result.success || !result.trade) continue;

    const originalLeg = legs[i];
    if (!originalLeg) continue;

    // Opposite side to close: buy → sell, yes stays yes
    const flattenAction = originalLeg.action === "buy" ? "sell" : "buy";

    try {
      const flatResp = await fetch(executeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticker: originalLeg.ticker,
          marketId: originalLeg.ticker,
          marketQuestion: originalLeg.market_question || originalLeg.ticker,
          side: originalLeg.side,
          action: flattenAction,
          price: originalLeg.price,
          amount: originalLeg.amount,
          strategy: strategyName || null,
          strategyId: strategyId || null,
          orderType: "limit",
          mode,
          notes: `FLATTEN: closing leg ${i + 1} of basket ${basketId} — basket incomplete`,
          basketId,
        }),
      });

      const flatResult = await flatResp.json();
      flattenResults.push({ leg_index: i, flatten_action: flattenAction, ...flatResult, success: Boolean(flatResp.ok && flatResult.success) });

      if (flatResult.trade?.id) {
        await supabase.from("trades").update({ basket_id: basketId }).eq("id", flatResult.trade.id);
      }
    } catch (err) {
      flattenResults.push({
        leg_index: i,
        flatten_action: flattenAction,
        error: err instanceof Error ? err.message : "flatten failed",
        success: false,
      });
    }
  }

  return flattenResults;
}
