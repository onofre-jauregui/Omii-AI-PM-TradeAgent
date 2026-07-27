import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import {
  getKalshiCredentials,
  generateAuthHeaders,
  fetchWithRetry,
  KALSHI_BASE_URL,
} from "../_shared/kalshi-auth.ts";
import { decideReconcile, contractCount, pickAvgPrice } from "../_shared/reconcile-logic.ts";

/**
 * reconcile-orders — advance live Kalshi orders that are still resting.
 *
 * The order-placement path (execute-trade) only captures a fill if the order
 * fills *immediately* on POST. A live limit order that rests as `open`/`partial`
 * is otherwise never advanced to `filled`, is invisible to auto-settle (whose
 * view is paper-only), and would eventually be wrongly zeroed by the expiration
 * sweep. This cron closes that gap: for every resting live order it re-reads the
 * order from Kalshi and advances the local `trades` row.
 *
 * State transitions (forward-only, idempotent):
 *   Kalshi order canceled/expired        → trades.status = 'cancelled'
 *   remaining_count == 0 (fully filled)  → 'filled'  (+ filled_price, filled_at)
 *   partially filled, still resting       → 'partial' (+ filled_price)
 *   still fully resting                   → no change
 *
 * filled_price is stored in CENTS to match execute-trade (kalshiOrder.avg_price).
 * Invoked by the reconcile-orders-cron pg_cron job (service-role bearer).
 */

interface TradeRow {
  id: string;
  user_id: string;
  order_id: string;
  ticker: string | null;
  side: string | null;
  price: number | null;
  amount: number | null;
  status: string;
}

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

  const summary = { checked: 0, filled: 0, partial: 0, cancelled: 0, unchanged: 0, errors: 0 };

  try {
    // All live orders still awaiting a terminal state.
    const { data: openOrders, error: qErr } = await supabase
      .from("trades")
      .select("id, user_id, order_id, ticker, side, price, amount, status")
      .eq("mode", "live")
      .in("status", ["open", "partial"])
      .is("settled_at", null)
      .not("order_id", "is", null);

    if (qErr) throw qErr;
    const orders = (openOrders ?? []) as TradeRow[];
    if (orders.length === 0) {
      return json({ ok: true, ...summary, message: "no resting live orders" });
    }

    // Group by user so we decrypt each user's key once.
    const byUser = new Map<string, TradeRow[]>();
    for (const o of orders) {
      if (!o.user_id || !o.order_id) continue;
      const arr = byUser.get(o.user_id) ?? [];
      arr.push(o);
      byUser.set(o.user_id, arr);
    }

    for (const [userId, userOrders] of byUser) {
      const { keyId, privateKey } = await getKalshiCredentials(supabase, userId);
      if (!keyId || !privateKey) {
        console.warn(`reconcile-orders: no Kalshi key for user ${userId} — skipping ${userOrders.length} orders`);
        await logCompliance(supabase, userId, null, "reconcile_order_check_failed",
          `reconcile-orders: no Kalshi key for user — ${userOrders.length} resting order(s) not reconciled`,
          { order_ids: userOrders.map((o) => o.order_id) }, "error");
        summary.errors += userOrders.length;
        continue;
      }

      for (const trade of userOrders) {
        summary.checked++;
        try {
          const kalshiOrder = await fetchKalshiOrder(keyId, privateKey, trade.order_id);
          if (!kalshiOrder) {
            await logCompliance(supabase, userId, trade.id, "reconcile_order_check_failed",
              `reconcile-orders: Kalshi GET order ${trade.order_id} failed — order not reconciled this cycle`,
              { order_id: trade.order_id }, "error");
            summary.errors++;
            continue;
          }

          const kStatus = String(kalshiOrder.status ?? "");
          const remaining = Number(kalshiOrder.remaining_count ?? -1);
          const initialCount = contractCount(trade.amount, trade.price);
          const avgPriceCents = pickAvgPrice(kalshiOrder);
          const decision = decideReconcile(kStatus, remaining, initialCount);
          // Kalshi's own fee fields on the order object — captured verbatim,
          // same as execute-trade's immediate-fill path (zero formula risk).
          const entryFeeCents = Math.round(
            parseFloat(kalshiOrder.maker_fees_dollars ?? kalshiOrder.taker_fees_dollars ?? "0") * 100
          );

          if (decision === "cancel") {
            await updateTrade(supabase, trade.id, {
              status: "cancelled",
              cancelled_at: new Date().toISOString(),
            });
            await logCompliance(supabase, userId, trade.id, "order_cancelled",
              `Live order ${trade.order_id} ${kStatus.toLowerCase()} on Kalshi`, { order_id: trade.order_id });
            summary.cancelled++;
          } else if (decision === "fill") {
            await updateTrade(supabase, trade.id, {
              status: "filled",
              filled_price: avgPriceCents ?? trade.price,
              filled_at: new Date().toISOString(),
              entry_fee_cents: entryFeeCents,
            });
            await logCompliance(supabase, userId, trade.id, "order_filled",
              `Live order ${trade.order_id} fully filled`, { order_id: trade.order_id, avg_price: avgPriceCents });
            summary.filled++;
          } else if (decision === "partial") {
            // Partially filled, still resting — capture the fill price, keep partial.
            await updateTrade(supabase, trade.id, {
              status: "partial",
              filled_price: avgPriceCents ?? trade.price,
              entry_fee_cents: entryFeeCents,
            });
            summary.partial++;
          } else {
            // Still fully resting — nothing to do.
            summary.unchanged++;
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error(`reconcile-orders: error on trade ${trade.id} (order ${trade.order_id}):`, errMsg);
          await logCompliance(supabase, userId, trade.id, "reconcile_order_check_failed",
            `reconcile-orders: unhandled error reconciling order ${trade.order_id}: ${errMsg}`,
            { order_id: trade.order_id }, "error");
          summary.errors++;
        }
      }
    }

    return json({ ok: true, ...summary });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("reconcile-orders fatal:", errMsg);
    await supabase.from("compliance_log").insert({
      event_type: "reconcile_orders_fatal",
      severity: "error",
      message: `reconcile-orders: run aborted — ${errMsg}`,
      metadata: summary,
    }).then(null, () => {});
    return json({ ok: false, error: errMsg, ...summary }, 500);
  }
});

// ── Kalshi ────────────────────────────────────────────────────────────────

async function fetchKalshiOrder(keyId: string, privateKey: string, orderId: string): Promise<any | null> {
  const path = `/trade-api/v2/portfolio/orders/${orderId}`;
  const ts = Date.now();
  const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, ts);
  const res = await fetchWithRetry(`${KALSHI_BASE_URL}/portfolio/orders/${orderId}`, { method: "GET", headers });
  if (!res.ok) {
    console.warn(`reconcile-orders: Kalshi GET order ${orderId} → ${res.status}`);
    return null;
  }
  const body = await res.json();
  return body?.order ?? body ?? null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function updateTrade(supabase: any, id: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("trades").update(patch).eq("id", id);
  if (error) throw error;
}

async function logCompliance(
  supabase: any, userId: string | null, tradeId: string | null, eventType: string, message: string,
  metadata: any = {}, severity: string = "info"
) {
  await supabase.from("compliance_log").insert({
    user_id: userId, trade_id: tradeId, event_type: eventType,
    severity, message, metadata,
  }).then(null, () => {});
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
