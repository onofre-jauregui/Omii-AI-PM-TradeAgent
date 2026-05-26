import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";
import { langfuseIngest, scoreEvent } from "../_shared/langfuse.ts";
import { captureException, captureMessage } from "../_shared/sentry.ts";

/**
 * auto-settle: Resolve paper trades against real Kalshi market outcomes.
 *
 * For every filled paper trade with no settlement yet:
 *   1. Fetch the Kalshi market state (public endpoint, no auth).
 *   2. If status='settled', read the 'result' field ('yes' | 'no').
 *   3. Compute realized PnL for the trade:
 *        - side=yes, result='yes'  → WIN: pnl = (100 - price)/100 * amount
 *        - side=yes, result='no'   → LOSS: pnl = -price/100 * amount
 *        - side=no,  result='no'   → WIN: pnl = ((100 - (100 - price))/100) * amount = price_NO_side_gain
 *        - side=no,  result='yes'  → LOSS
 *   4. Update trades.settled_at, trades.resolution, trades.pnl, trades.status
 *   5. Update trade_reflections.actual_outcome, actual_pnl, decision_quality
 *   6. Log to compliance_log.
 *
 * Safe to run repeatedly: only touches unsettled rows.
 */

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

interface KalshiMarket {
  ticker: string;
  status: string; // 'active' | 'settled' | 'closed' | ...
  result?: string; // 'yes' | 'no' | '' when not settled
  settlement_value?: string;
  // other fields omitted
}

async function fetchKalshiMarket(ticker: string): Promise<KalshiMarket | null> {
  try {
    const resp = await fetch(`${KALSHI_BASE}/markets/${ticker}`);
    if (!resp.ok) {
      console.warn(`Kalshi market ${ticker} fetch failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    return data?.market || null;
  } catch (e) {
    console.error(`Kalshi fetch error for ${ticker}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Compute realized PnL in dollars for a single trade given the market result.
 * Kalshi contracts pay $1 per contract if correct, $0 otherwise.
 * Amount here is USD deployed, price is entry price in cents (1-99).
 */
function computePnl(
  side: string,
  action: string,
  priceInCents: number,
  amountUsd: number,
  result: string
): { pnl: number; outcome: "win" | "loss" | "void" } {
  if (result !== "yes" && result !== "no") {
    return { pnl: 0, outcome: "void" };
  }
  const priceDollars = priceInCents / 100;
  // Number of contracts we hold = amount / price_per_contract
  const contracts = priceDollars > 0 ? amountUsd / priceDollars : 0;

  if (action !== "buy") {
    // Sell trades aren't handled for paper pnl yet (would need to track the
    // matching buy leg). Mark as void for now.
    return { pnl: 0, outcome: "void" };
  }

  const correctSide = (side === "yes" && result === "yes") || (side === "no" && result === "no");
  if (correctSide) {
    // Win: each contract pays $1; profit per contract = 1 - price
    return { pnl: contracts * (1 - priceDollars), outcome: "win" };
  }
  // Loss: entire position lost
  return { pnl: -contracts * priceDollars, outcome: "loss" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({ error: "Missing Supabase credentials" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const runStartedAt = new Date().toISOString();
  const runId = crypto.randomUUID();

  try {
    // 1. Find all (ticker, user_id) pairs with unsettled filled paper trades.
    // View now groups by both so each user's positions are isolated.
    const { data: pendingTickers, error: pendingErr } = await supabase
      .from("agent_trades_pending_resolution")
      .select("ticker, user_id, trades_pending, trade_ids, earliest_entry");

    if (pendingErr) {
      console.error("pending fetch error:", pendingErr);
      return new Response(
        JSON.stringify({ error: pendingErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pendingTickers || pendingTickers.length === 0) {
      await supabase.from("compliance_log").insert({
        event_type: "auto_settle_run",
        severity: "info",
        message: "auto-settle: no pending trades",
        metadata: { run_id: runId },
      });
      return new Response(
        JSON.stringify({ success: true, run_id: runId, pending_tickers: 0, settled: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalSettled = 0;
    let totalStillPending = 0;
    const results: any[] = [];

    // 2. For each (ticker, user_id) pair, fetch Kalshi and settle if resolved.
    // The view now groups by both columns so each user's positions are independent.
    for (const row of pendingTickers) {
      const ticker = row.ticker as string;
      const tradeIds = row.trade_ids as string[];

      const market = await fetchKalshiMarket(ticker);

      if (!market) {
        results.push({ ticker, state: "fetch_failed", trades: tradeIds.length });
        totalStillPending += tradeIds.length;
        continue;
      }

      // Kalshi status → action mapping (exhaustive):
      //   active          → skip, still trading
      //   closed + result → settle with P&L (Kalshi published result before final bookkeeping)
      //   closed + empty  → skip, result not published yet
      //   settled         → settle with P&L (normal path)
      //   finalized       → settle with P&L (same as settled)
      //   voided/cancelled → refund at cost, pnl = 0
      const hasResult =
        typeof market.result === "string" &&
        market.result !== "" &&
        market.result !== "undetermined";
      const isVoided = ["voided", "cancelled"].includes(market.status);
      const isSettled =
        isVoided ||
        market.status === "finalized" ||
        market.status === "settled" ||
        hasResult;

      if (!isSettled) {
        results.push({ ticker, state: "still_open", status: market.status, trades: tradeIds.length });
        totalStillPending += tradeIds.length;
        continue;
      }

      // Voided/cancelled: refund at cost (no gain, no loss)
      if (isVoided) {
        const { data: voidedTrades } = await supabase
          .from("trades")
          .select("id")
          .in("id", tradeIds);
        if (voidedTrades && voidedTrades.length > 0) {
          await supabase.from("trades").update({
            status: "settled",
            settled_at: new Date().toISOString(),
            resolution: "voided",
            pnl: 0,
          }).in("id", voidedTrades.map((t: any) => t.id));
          await supabase.from("compliance_log").insert({
            event_type: "trade_settled",
            severity: "info",
            message: `auto-settle: ${voidedTrades.length} trade(s) on ${ticker} voided/cancelled — refunded at cost`,
            metadata: { ticker, status: market.status, trade_ids: voidedTrades.map((t: any) => t.id) },
          });
          totalSettled += voidedTrades.length;
          results.push({ ticker, state: "voided", trades_settled: voidedTrades.length });
        }
        continue;
      }

      const resolution = (market.result || "").toLowerCase();

      // 3. Fetch the actual trade rows so we can compute per-trade pnl
      const { data: trades, error: tradesErr } = await supabase
        .from("trades")
        .select("id, user_id, side, action, price, amount, created_at, trace_id")
        .in("id", tradeIds);

      if (tradesErr || !trades) {
        results.push({ ticker, state: "fetch_trades_failed", error: tradesErr?.message });
        continue;
      }

      let settledInTicker = 0;
      for (const t of trades) {
        const { pnl, outcome } = computePnl(
          t.side as string,
          t.action as string,
          Number(t.price),
          Number(t.amount),
          resolution
        );

        // 4. Update the trade row
        const { error: updErr } = await supabase
          .from("trades")
          .update({
            status: "settled",
            settled_at: new Date().toISOString(),
            resolution: resolution === "yes" || resolution === "no" ? resolution : "void",
            pnl: Math.round(pnl * 100) / 100,
          })
          .eq("id", t.id);

        if (updErr) {
          console.error(`trade ${t.id} update failed:`, updErr.message);
          captureMessage(`auto-settle: trade update failed for ${t.id}`, "error", {
            function: "auto-settle",
            extra: { trade_id: t.id, ticker, pnl, outcome, error: updErr.message },
          });
          continue;
        }

        // Langfuse score: link qualify decision to trade outcome
        if (t.trace_id && outcome !== "void") {
          langfuseIngest([scoreEvent(
            t.trace_id,
            "trade-pnl-correct",
            outcome === "win" ? 1 : 0,
            `pnl: $${(Math.round(pnl * 100) / 100).toFixed(2)} on ${ticker}`,
          )]);
          // Confirmation row so we can verify scores are firing from the DB
          supabase.from("compliance_log").insert({
            event_type: "langfuse_score_sent",
            severity: "info",
            message: `Langfuse score: ${outcome} · pnl=$${(Math.round(pnl * 100) / 100).toFixed(2)} · ${ticker}`,
            trade_id: t.id,
            metadata: { trace_id: t.trace_id, outcome, pnl: Math.round(pnl * 100) / 100 },
          }).then(() => {}).catch(() => {});
        }

        // 4b. Write outcome back to the originating signal so param_sweep
        //     and signal_quality backtest modes have real win-rate data.
        //     Match: same ticker, signal created before this trade was placed.
        if (outcome !== "void") {
          const tradeUserId = t.user_id ?? null;
          const { data: sig } = await supabase
            .from("signals")
            .select("id")
            .eq("ticker", ticker)
            .or(tradeUserId ? `user_id.is.null,user_id.eq.${tradeUserId}` : "user_id.is.null")
            .lte("created_at", t.created_at || new Date().toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (sig) {
            await supabase.from("signals").update({
              outcome_correct: outcome === "win",
              outcome_pnl: Math.round(pnl * 100) / 100,
              was_acted_on: true,
            }).eq("id", sig.id);
          }
        }

        // 5. Update reflection with actual outcome
        await supabase
          .from("trade_reflections")
          .update({
            actual_outcome: `Market settled ${resolution.toUpperCase()} — trade ${outcome.toUpperCase()}`,
            actual_pnl: Math.round(pnl * 100) / 100,
            decision_quality: outcome === "win" ? "good" : outcome === "loss" ? "bad" : "void",
          })
          .eq("trade_id", t.id);

        // 6. Compliance audit entry
        await supabase.from("compliance_log").insert({
          event_type: "trade_settled",
          severity: "info",
          trade_id: t.id,
          message: `Settled ${ticker}: ${outcome.toUpperCase()} pnl=$${(Math.round(pnl * 100) / 100).toFixed(2)}`,
          metadata: { run_id: runId, resolution, outcome, original_price: t.price, amount: t.amount },
        });

        // 7. Auto stop-loss: if the trade settled at a loss ≥ stop_loss_pct% of amount,
        //    halt trading for the rest of today for this user.
        if (pnl < 0 && t.user_id) {
          const { data: riskRow } = await supabase
            .from("risk_settings")
            .select("auto_stop_loss, stop_loss_pct")
            .eq("user_id", t.user_id)
            .maybeSingle();

          if (riskRow?.auto_stop_loss && (riskRow.stop_loss_pct ?? 0) > 0) {
            const lossPct = (Math.abs(pnl) / (Number(t.amount) || 1)) * 100;
            if (lossPct >= riskRow.stop_loss_pct) {
              const today = new Date().toISOString().split("T")[0];
              await supabase.from("risk_state").upsert(
                {
                  user_id: t.user_id,
                  date: today,
                  is_trading_halted: true,
                  halt_reason: `Auto stop-loss: ${ticker} lost ${lossPct.toFixed(1)}% (threshold: ${riskRow.stop_loss_pct}%)`,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "user_id,date" }
              );
              await supabase.from("compliance_log").insert({
                event_type: "auto_stop_loss_triggered",
                severity: "warning",
                trade_id: t.id,
                user_id: t.user_id,
                message: `Auto stop-loss halted trading: ${ticker} lost ${lossPct.toFixed(1)}% (threshold: ${riskRow.stop_loss_pct}%)`,
                metadata: { pnl: Math.round(pnl * 100) / 100, amount: t.amount, lossPct, threshold: riskRow.stop_loss_pct, run_id: runId },
              });
            }
          }
        }

        settledInTicker += 1;
      }

      totalSettled += settledInTicker;
      results.push({
        ticker,
        state: "settled",
        resolution,
        trades_settled: settledInTicker,
      });

    }

    // 6. Trigger auto-reflect once per settle run (not once per ticker).
    //    Moved outside the ticker loop to prevent concurrent duplicate runs
    //    when multiple tickers settle in the same batch.
    if (totalSettled > 0) {
      fetch(`${supabaseUrl}/functions/v1/auto-reflect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.warn("auto-reflect trigger failed:", e instanceof Error ? e.message : e));
    }

    // 7. Run-level rollup compliance entry
    await supabase.from("compliance_log").insert({
      event_type: "auto_settle_run",
      severity: "info",
      message: `auto-settle: ${totalSettled} trades settled across ${results.filter(r => r.state === "settled").length} tickers, ${totalStillPending} still pending`,
      metadata: { run_id: runId, started_at: runStartedAt, results },
    });

    return new Response(
      JSON.stringify({
        success: true,
        run_id: runId,
        pending_tickers_checked: pendingTickers.length,
        trades_settled: totalSettled,
        trades_still_pending: totalStillPending,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("auto-settle fatal:", errMsg);
    captureException(e instanceof Error ? e : new Error(errMsg), { function: "auto-settle" });
    try {
      await supabase.from("compliance_log").insert({
        event_type: "auto_settle_error",
        severity: "error",
        message: `auto-settle fatal: ${errMsg}`,
        metadata: { run_id: runId, stack: e instanceof Error ? e.stack : undefined },
      });
      await sendTelegramAlert(`🔴 <b>[TradeAgent] Settlement Crashed</b>\n${errMsg.slice(0, 200)}\nPositions may not be settling — P&L is not realizing. Check immediately.`);
    } catch {}
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
