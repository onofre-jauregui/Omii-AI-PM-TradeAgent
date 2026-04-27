import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

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
    // 1. Find all unique tickers with unsettled filled paper trades
    const { data: pendingTickers, error: pendingErr } = await supabase
      .from("agent_trades_pending_resolution")
      .select("ticker, trades_pending, trade_ids, earliest_entry");

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

    // 2. For each ticker, fetch Kalshi and settle if resolved
    for (const row of pendingTickers) {
      const ticker = row.ticker as string;
      const tradeIds = row.trade_ids as string[];

      const market = await fetchKalshiMarket(ticker);

      if (!market) {
        results.push({ ticker, state: "fetch_failed", trades: tradeIds.length });
        totalStillPending += tradeIds.length;
        continue;
      }

      // Kalshi uses various status values; settlement is marked by 'settled'
      // or non-empty 'result' field.
      const isSettled =
        market.status === "settled" ||
        (typeof market.result === "string" && market.result !== "" && market.result !== "undetermined");

      if (!isSettled) {
        results.push({ ticker, state: "still_open", status: market.status, trades: tradeIds.length });
        totalStillPending += tradeIds.length;
        continue;
      }

      const resolution = (market.result || "").toLowerCase();

      // 3. Fetch the actual trade rows so we can compute per-trade pnl
      const { data: trades, error: tradesErr } = await supabase
        .from("trades")
        .select("id, side, action, price, amount, created_at")
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
          continue;
        }

        // 4b. Write outcome back to the originating signal so param_sweep
        //     and signal_quality backtest modes have real win-rate data.
        //     Match: same ticker, signal created before this trade was placed.
        if (outcome !== "void") {
          const { data: sig } = await supabase
            .from("signals")
            .select("id")
            .eq("ticker", ticker)
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
    try {
      await supabase.from("compliance_log").insert({
        event_type: "auto_settle_error",
        severity: "error",
        message: `auto-settle fatal: ${errMsg}`,
        metadata: { run_id: runId, stack: e instanceof Error ? e.stack : undefined },
      });
    } catch {}
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
