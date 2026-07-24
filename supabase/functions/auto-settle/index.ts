import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";
import { sendUserNotification } from "../_shared/notifications.ts";
import { langfuseIngest, scoreEvent } from "../_shared/langfuse.ts";
import { captureException, captureMessage } from "../_shared/sentry.ts";
import { computePnl, resolveKalshiMarketAction } from "../_shared/trading-logic.ts";

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
      const marketAction = resolveKalshiMarketAction(market.status, market.result);

      if (marketAction === "skip") {
        results.push({ ticker, state: "still_open", status: market.status, trades: tradeIds.length });
        totalStillPending += tradeIds.length;
        continue;
      }

      // Voided/cancelled: refund at cost (no gain, no loss)
      if (marketAction === "void") {
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

      // 3. Fetch the actual trade rows so we can compute per-trade pnl.
      //    Filter to status=filled + settled_at IS NULL so re-runs on the same
      //    market resolution are no-ops — prevents double-settlement and double
      //    Langfuse scoring if auto-settle fires twice before the first run commits.
      const { data: trades, error: tradesErr } = await supabase
        .from("trades")
        .select("id, user_id, side, action, price, amount, created_at, trace_id, mode")
        .in("id", tradeIds)
        .eq("status", "filled")
        .is("settled_at", null);

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

        // 5b. S-005 calibration feedback — write per-trade outcome to weather_bucket_calibration
        //     so the weather model can detect systematic per-city/bucket bias over time.
        if (outcome !== "void" && (ticker ?? "").startsWith("KXHIGH")) {
          const cityMatch = ticker.match(/^KXHIGH([A-Z]+)-/);
          const bucketMatch = ticker.match(/-B([\d.]+)$/);
          const calCity = cityMatch?.[1] ?? null;
          const calBucket = bucketMatch ? parseFloat(bucketMatch[1]) : null;
          if (calCity && calBucket !== null) {
            const yesSideWon = (t.side === "yes" && pnl > 0) || (t.side === "no" && pnl < 0);
            await supabase.from("weather_bucket_calibration").upsert({
              location_code: calCity,
              bucket_threshold: calBucket,
              trade_date: new Date().toISOString().slice(0, 10),
              yes_resolved: yesSideWon,
              pnl: Math.round(pnl * 100) / 100,
              side: t.side,
              ticker,
            }, { onConflict: "location_code,trade_date,bucket_threshold,ticker" }).then(undefined, () => {});
          }
        }

        // 6. Compliance audit entry
        await supabase.from("compliance_log").insert({
          event_type: "trade_settled",
          severity: "info",
          trade_id: t.id,
          message: `Settled ${ticker}: ${outcome.toUpperCase()} pnl=$${(Math.round(pnl * 100) / 100).toFixed(2)}`,
          metadata: { run_id: runId, resolution, outcome, original_price: t.price, amount: t.amount },
        });

        // Notify user of position settlement (live trades only, fire-and-forget)
        if (t.mode === "live" && t.user_id) {
          const settledPnl = Math.round(pnl * 100) / 100;
          const isWin = settledPnl > 0;
          const pnlColor = isWin ? "#22c55e" : "#ef4444";
          const pnlLabel = isWin ? "WIN" : outcome === "void" ? "VOID" : "LOSS";
          sendUserNotification(supabase, {
            userId: t.user_id,
            eventType: "position_closed",
            subject: `Position settled: ${ticker} — ${pnlLabel} ${isWin ? "+" : ""}$${Math.abs(settledPnl).toFixed(2)}`,
            htmlBody: `
              <h2 style="color:${pnlColor};font-size:28px;font-weight:700;margin:0 0 4px;">${isWin ? "+" : ""}$${Math.abs(settledPnl).toFixed(2)}</h2>
              <p style="color:rgba(255,255,255,0.5);font-size:14px;margin:0 0 24px;">${ticker} — ${pnlLabel}</p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Market resolved</td><td style="color:#fff;text-align:right;">${resolution.toUpperCase()}</td></tr>
                <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Position size</td><td style="color:#fff;text-align:right;">$${t.amount}</td></tr>
              </table>`,
            smsBody: `TradeAgent: ${ticker} settled ${pnlLabel} ${isWin ? "+" : ""}$${Math.abs(settledPnl).toFixed(2)}`,
          }).catch(() => {});
        }

        // 7. Daily drawdown circuit breaker: halt if cumulative daily loss exceeds max_daily_loss.
        //    Binary prediction contracts always lose 100% of the bet on settlement — a per-trade
        //    loss-percentage check would fire on every normal losing trade. Use daily PnL instead.
        if (pnl < 0 && t.user_id) {
          const today = new Date().toISOString().split("T")[0];
          // Scope by (user_id, mode): risk_settings has one row per mode, so a
          // user_id-only query matches both rows and .maybeSingle() errors →
          // riskRow becomes null and this daily-loss breaker silently never fires.
          const { data: riskRow } = await supabase
            .from("risk_settings")
            .select("auto_stop_loss, max_daily_loss")
            .eq("user_id", t.user_id)
            .eq("mode", t.mode)
            .maybeSingle();

          if (riskRow?.auto_stop_loss && (riskRow.max_daily_loss ?? 0) > 0) {
            const { data: stateRow } = await supabase
              .from("risk_state")
              .select("daily_pnl")
              .eq("user_id", t.user_id)
              .eq("date", today)
              .maybeSingle();

            const dailyPnl = Number(stateRow?.daily_pnl ?? 0) + pnl;
            const limit = -Math.abs(Number(riskRow.max_daily_loss));

            if (dailyPnl <= limit) {
              await supabase.from("risk_state").upsert(
                {
                  user_id: t.user_id,
                  date: today,
                  is_trading_halted: true,
                  halt_reason: `Daily loss limit reached: $${Math.abs(dailyPnl).toFixed(2)} lost (limit: $${riskRow.max_daily_loss})`,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "user_id,date" }
              );
              await supabase.from("compliance_log").insert({
                event_type: "auto_stop_loss_triggered",
                severity: "warning",
                trade_id: t.id,
                user_id: t.user_id,
                message: `Daily loss limit reached: $${Math.abs(dailyPnl).toFixed(2)} (limit $${riskRow.max_daily_loss}). Trading halted.`,
                metadata: { daily_pnl: dailyPnl, limit, triggering_trade: ticker, run_id: runId },
              });

              const lossAmt = Math.abs(dailyPnl).toFixed(2);
              sendUserNotification(supabase, {
                userId: t.user_id,
                eventType: "stop_loss_hit",
                forceChannel: "both",
                subject: `Daily loss limit hit — trading halted`,
                htmlBody: `
                  <h2 style="color:#ef4444;font-size:22px;font-weight:700;margin:0 0 4px;">Daily Loss Limit Reached</h2>
                  <p style="color:rgba(255,255,255,0.5);font-size:14px;margin:0 0 24px;">Trading halted for the rest of today</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
                    <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Today's loss</td><td style="color:#ef4444;text-align:right;">-$${lossAmt}</td></tr>
                    <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Daily limit</td><td style="color:#fff;text-align:right;">$${riskRow.max_daily_loss}</td></tr>
                    <tr><td style="color:rgba(255,255,255,0.5);padding:6px 0;">Status</td><td style="color:#ef4444;text-align:right;font-weight:600;">HALTED</td></tr>
                  </table>
                  <p style="color:rgba(255,255,255,0.6);font-size:13px;">All trading is paused for today. Resume from the dashboard when ready.</p>`,
                smsBody: `TradeAgent ALERT: Daily loss limit hit (-$${lossAmt} / limit $${riskRow.max_daily_loss}). Trading HALTED today.`,
              }).catch(() => {});
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

    // 6. Expiration sweep: force-expire any trade that is past deadline and unreachable
    //    by Kalshi. This covers trades placed on markets that have since finalized and
    //    left the Kalshi API — fetchKalshiMarket() returns null for them, leaving them
    //    stuck open forever unless this sweep runs. 4h grace period prevents premature
    //    closure of markets in final settlement processing.
    //
    //    PAPER ONLY. A live order represents real money — force-expiring it to pnl=0
    //    would destroy a real outcome. Live orders settle via market resolution (the
    //    pending-resolution view now includes live) or are handled by reconcile-orders;
    //    anything that genuinely can't resolve stays 'filled' for manual review.
    const expiryCutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: expiredByTime } = await supabase
      .from("trades")
      .select("id, ticker")
      .eq("status", "filled")
      .eq("mode", "paper")
      .is("settled_at", null)
      .not("expiration_time", "is", null)
      .lt("expiration_time", expiryCutoff);

    if (expiredByTime && expiredByTime.length > 0) {
      await supabase.from("trades").update({
        status: "expired",
        settled_at: new Date().toISOString(),
        resolution: "expired",
        pnl: 0,
      }).in("id", expiredByTime.map((t: any) => t.id));
      await supabase.from("compliance_log").insert({
        event_type: "auto_settle_expiry_sweep",
        severity: "info",
        message: `auto-settle: force-expired ${expiredByTime.length} trade(s) past deadline with no Kalshi result`,
        metadata: {
          run_id: runId,
          trade_count: expiredByTime.length,
          tickers: [...new Set(expiredByTime.map((t: any) => t.ticker))],
        },
      });
      totalSettled += expiredByTime.length;
    }

    // 7. Trigger auto-reflect once per settle run (not once per ticker).
    //    Moved outside the ticker loop to prevent concurrent duplicate runs
    //    when multiple tickers settle in the same batch.
    if (totalSettled > 0) {
      fetch(`${supabaseUrl}/functions/v1/auto-reflect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.warn("auto-reflect trigger failed:", e instanceof Error ? e.message : e));
    }

    // 8. Run-level rollup compliance entry
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
