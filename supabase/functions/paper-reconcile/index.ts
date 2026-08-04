import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { fetchOrderbook, fetchMarketStatus } from "../_shared/kalshi-market-data.ts";
import { simulatePaperFill, estimateKalshiFee } from "../_shared/fill-sim.ts";
import { decidePaperReconcile } from "../_shared/reconcile-logic.ts";
import { KALSHI_BASE_URL } from "../_shared/kalshi-signing.ts";

/**
 * paper-reconcile — advance resting paper orders that didn't instantly fill.
 *
 * Mirrors reconcile-orders, but for paper: since a paper "order" isn't a real
 * resting order on Kalshi, there's nothing to poll by order_id. Instead this
 * re-simulates the ORIGINAL requested fill (same price/amount/side/action)
 * against the CURRENT real orderbook — if the market has since moved enough
 * that the requested price would now be marketable, the paper order advances.
 * No credentials needed — orderbook reads are public, and no real orders are
 * ever placed for paper.
 *
 * State transitions (forward-only, idempotent):
 *   ticker delisted (404/410)                    → 'cancelled'
 *   full requested size now covered by real book  → 'filled'  (+ filled_price, filled_at, entry_fee_cents)
 *   some but not all covered                      → 'partial' (+ filled_price, entry_fee_cents)
 *   still nothing covered                         → no change
 *
 * Invoked by the paper-reconcile-cron pg_cron job (service-role bearer).
 */

interface TradeRow {
  id: string;
  ticker: string;
  side: string;
  action: string;
  price: number;
  amount: number;
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
  const kalshiBase = Deno.env.get("KALSHI_BASE_URL") || KALSHI_BASE_URL;
  const startedAt = Date.now();

  const summary = { checked: 0, filled: 0, partial: 0, cancelled: 0, unchanged: 0, errors: 0 };

  try {
    const { data: openTrades, error: qErr } = await supabase
      .from("trades")
      .select("id, ticker, side, action, price, amount, status")
      .eq("mode", "paper")
      .in("status", ["open", "partial"])
      .is("settled_at", null)
      .not("ticker", "is", null);

    if (qErr) throw qErr;
    const trades = (openTrades ?? []) as TradeRow[];
    if (trades.length === 0) {
      await logRunSummary(supabase, summary, Date.now() - startedAt);
      return json({ ok: true, ...summary, message: "no resting paper orders" });
    }

    // Group by ticker — one real orderbook fetch serves every trade on that ticker.
    const byTicker = new Map<string, TradeRow[]>();
    for (const t of trades) {
      const arr = byTicker.get(t.ticker) ?? [];
      arr.push(t);
      byTicker.set(t.ticker, arr);
    }

    for (const [ticker, tickerTrades] of byTicker) {
      const orderbookResult = await fetchOrderbook(kalshiBase, ticker);

      // Whether the market can still trade at all — one call per ticker, not per
      // order. A resolved market still answers its orderbook endpoint with HTTP
      // 200 and an empty book, so without this the loop below can only ever ask
      // "does it fill now?" and never "can it ever fill?", and orders on settled
      // markets rest forever (see decidePaperReconcile's marketStatus branch).
      // undefined = unknown; the decision then falls through to "none" exactly
      // as before, so a flaky status call can never cancel a live order.
      const marketStatus = orderbookResult.ok
        ? await fetchMarketStatus(kalshiBase, ticker)
        : undefined;

      for (const trade of tickerTrades) {
        summary.checked++;
        try {
          if (!orderbookResult.ok) {
            if (orderbookResult.tickerGone) {
              await updateTrade(supabase, trade.id, {
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
              });
              await logCompliance(supabase, trade.id, "paper_order_cancelled",
                `Paper order on ${ticker} cancelled — market no longer listed on Kalshi`, { ticker });
              summary.cancelled++;
            } else {
              // Transient network/5xx/malformed-body failure — leave unchanged, retry
              // next cycle, but log the raw cause so it's distinguishable from a
              // delisting instead of vanishing into an error counter with no detail.
              await logCompliance(supabase, trade.id, "orderbook_fetch_failed",
                `Orderbook fetch failed for ${ticker}${orderbookResult.status ? ` (status ${orderbookResult.status})` : ""}${orderbookResult.error ? `: ${orderbookResult.error}` : ""}`,
                { ticker, status: orderbookResult.status, error: orderbookResult.error ?? null }, "warning"
              );
              summary.errors++;
            }
            continue;
          }

          const fill = simulatePaperFill(
            orderbookResult.orderbook,
            trade.side as "yes" | "no",
            trade.action as "buy" | "sell",
            Number(trade.price),
            Number(trade.amount)
          );
          const decision = decidePaperReconcile(
            false,
            fill.filledContracts,
            fill.requestedContracts,
            marketStatus
          );

          if (decision === "cancel") {
            await updateTrade(supabase, trade.id, {
              status: "cancelled",
              cancelled_at: new Date().toISOString(),
            });
            await logCompliance(supabase, trade.id, "paper_order_cancelled",
              `Paper order on ${ticker} cancelled — market ${marketStatus} before the order could fill`,
              { ticker, market_status: marketStatus });
            summary.cancelled++;
          } else if (decision === "fill" || decision === "partial") {
            // A resting order that only now clears is a maker fill by definition —
            // it never crossed the book at placement time.
            const entryFeeCents = estimateKalshiFee(fill.filledPrice!, fill.filledContracts, true);
            await updateTrade(supabase, trade.id, {
              status: decision === "fill" ? "filled" : "partial",
              filled_price: fill.filledPrice,
              filled_at: decision === "fill" ? new Date().toISOString() : null,
              entry_fee_cents: entryFeeCents,
            });
            await logCompliance(supabase, trade.id,
              decision === "fill" ? "paper_order_filled" : "paper_order_partial",
              `Paper order on ${ticker} ${decision === "fill" ? "fully filled" : "partially filled"} on reconcile — ${fill.filledContracts}/${fill.requestedContracts} @ ${fill.filledPrice}c`,
              { ticker, filled: fill.filledContracts, requested: fill.requestedContracts, filled_price: fill.filledPrice }
            );
            if (decision === "fill") summary.filled++; else summary.partial++;
          } else {
            summary.unchanged++;
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error(`paper-reconcile: error on trade ${trade.id} (${ticker}):`, errMsg);
          await logCompliance(supabase, trade.id, "reconcile_order_check_failed",
            `paper-reconcile: unhandled error reconciling ${ticker}: ${errMsg}`, { ticker }, "error");
          summary.errors++;
        }
      }
    }

    await logRunSummary(supabase, summary, Date.now() - startedAt);
    return json({ ok: true, ...summary });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("paper-reconcile fatal:", errMsg);
    await supabase.from("compliance_log").insert({
      event_type: "paper_reconcile_fatal",
      severity: "error",
      message: `paper-reconcile: run aborted — ${errMsg}`,
      metadata: { ...summary, elapsed_ms: Date.now() - startedAt },
    }).then(null, () => {});
    return json({ ok: false, error: errMsg, ...summary }, 500);
  }
});

// Run-level heartbeat so a slow or lagging pass is visible in compliance_log
// instead of only reconstructable from scattered per-order rows — the same gap
// reconcile-orders had until the 2026-07-28 health-check run (see docs/
// health-log.md 41st run). paper-reconcile-cron shipped a day earlier
// (20260727_paper_reconcile_cron.sql) as a direct mirror of reconcile-orders
// but without this. Warns when a pass runs long enough to risk overlapping
// the next 5-min cycle.
async function logRunSummary(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  summary: { checked: number; filled: number; partial: number; cancelled: number; unchanged: number; errors: number },
  elapsedMs: number,
) {
  const severity = elapsedMs > 4 * 60 * 1000 ? "warning" : "info";
  await supabase.from("compliance_log").insert({
    event_type: "paper_reconcile_run",
    severity,
    message: `paper-reconcile: ${summary.checked} checked, ${summary.filled} filled, ${summary.partial} partial, ${summary.cancelled} cancelled, ${summary.errors} errors (${elapsedMs}ms)`,
    metadata: { ...summary, elapsed_ms: elapsedMs },
  }).then(null, () => {});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function updateTrade(supabase: any, id: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("trades").update(patch).eq("id", id);
  if (error) throw error;
}

async function logCompliance(
  supabase: any, tradeId: string | null, eventType: string, message: string,
  metadata: any = {}, severity: string = "info"
) {
  await supabase.from("compliance_log").insert({
    trade_id: tradeId, event_type: eventType, severity, message, metadata,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
