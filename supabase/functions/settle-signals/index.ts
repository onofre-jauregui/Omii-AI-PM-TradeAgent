import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

/**
 * settle-signals: Computes shadow PnL for all signals whose markets have resolved.
 *
 * This is the biggest data unlock in v2: we learn from signals we SKIPPED,
 * not just signals we traded. This lets us measure qualifier ROI — whether
 * the LLM qualifier is adding value or destroying it.
 *
 * Shadow PnL = what 1 contract would have made if we had taken the signal.
 *   YES signals: settlement - entry_price (in cents, normalized to $)
 *   NO signals:  (100 - settlement) - (100 - entry_price)
 *
 * Scheduled: every 15 minutes via pg_cron.
 */

const CREDENTIAL_FETCH_TIMEOUT_MS = 8_000; // same bound as market-data-fetcher/health-check/reconcile-orders

function getKalshiBaseUrl(): string {
  return Deno.env.get("KALSHI_BASE_URL") || KALSHI_BASE_URL;
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

  try {
    // ── 1. Find unsettled signals whose markets have likely resolved ─────────
    // Use expires_at as a filter: only check signals past their expiration.
    // This avoids unnecessary Kalshi API calls for active markets.
    // Gate on settled_at (not settlement_price): a permanently-unsettleable
    // signal (Kalshi 404 — aged out of archive retention) gets settled_at
    // stamped with settlement_price left null, so it's excluded from future
    // batches instead of being re-selected every tick forever (see the
    // "watch item" in the 2026-07-28 46th-run health-check entry — without
    // this, the same oldest ~200 rows never rotate and the real backlog
    // behind them never gets a chance to settle).
    const { data: unsettledSignals, error: unsettledError } = await supabase
      .from("signals")
      .select("id, ticker, direction, mid_price, expires_at, system_version")
      .is("settled_at", null)
      .lt("expires_at", new Date().toISOString())
      .limit(200); // batch size — next run catches the rest

    if (unsettledError) {
      throw new Error(`Failed to query unsettled signals: ${unsettledError.message}`);
    }

    if (!unsettledSignals || unsettledSignals.length === 0) {
      return new Response(JSON.stringify({ settled: 0, reason: "No unsettled signals past expiration" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2. Group by ticker to avoid duplicate Kalshi API calls ───────────────
    const tickerToSignals = new Map<string, typeof unsettledSignals>();
    for (const sig of unsettledSignals) {
      if (!tickerToSignals.has(sig.ticker)) tickerToSignals.set(sig.ticker, []);
      tickerToSignals.get(sig.ticker)!.push(sig);
    }

    // ── 3. Fetch settlement data from Kalshi ─────────────────────────────────
    const kalshiBase = getKalshiBaseUrl();
    let settledCount = 0;
    const results: { ticker: string; status: string; settlement?: string }[] = [];

    // Use system service credentials for Kalshi API.
    // A stalled query here doesn't throw, so the outer try/catch below never
    // fires — it would silently eat the entire 15-min settle-signals run,
    // stalling shadow-PnL attribution for every unsettled signal with no
    // alert. Same class of gap the 51st/52nd runs closed in health-check and
    // reconcile-orders; bounded to the same 8s budget.
    let kalshiKeyId: string | null, kalshiPrivateKey: string | null;
    {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`credential fetch exceeded ${CREDENTIAL_FETCH_TIMEOUT_MS}ms`)),
          CREDENTIAL_FETCH_TIMEOUT_MS
        );
      });
      try {
        const creds = await Promise.race([getKalshiCredentials(supabase, null), timeout]);
        kalshiKeyId = creds.keyId;
        kalshiPrivateKey = creds.privateKey;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    for (const [ticker, signals] of tickerToSignals) {
      try {
        // Fetch market details to check settlement status
        const marketPath = `/trade-api/v2/markets/${ticker}`;
        const timestamp = Date.now();
        const authHeaders = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, "GET", marketPath, timestamp);

        const marketResp = await fetch(`${kalshiBase}${marketPath}`, {
          method: "GET",
          headers: authHeaders,
        });

        if (!marketResp.ok) {
          await supabase.from("compliance_log").insert({
            event_type: "api_error",
            severity: "warning",
            message: `settle-signals: Kalshi ${marketResp.status} fetching ${ticker}`,
            metadata: { provider: "kalshi", status: marketResp.status, endpoint: ticker },
          }).then(undefined, () => {});

          if (marketResp.status === 404) {
            // Definitive "this ticker doesn't exist" — Kalshi's archive
            // retention has aged it out, it will never return non-404.
            // Stamp settled_at (settlement_price/shadow_pnl stay null, so
            // ROI aggregates aren't polluted with fake settlements) so this
            // ticker's signals stop consuming a batch slot on every future
            // tick. Non-404 failures (5xx/timeout) are left untouched —
            // those are plausibly transient and should be retried.
            await supabase.from("signals").update({
              settled_at: new Date().toISOString(),
              settlement_status: "unsettleable_404",
            }).eq("ticker", ticker).is("settled_at", null);
            results.push({ ticker, status: "unsettleable_404" });
          } else {
            results.push({ ticker, status: "api_error" });
          }
          continue;
        }

        const marketData = await marketResp.json();
        const market = marketData.market;

        // Only process closed/resolved markets
        if (market.status !== "closed" && market.status !== "settled") {
          results.push({ ticker, status: `not_resolved (${market.status})` });
          continue;
        }

        // Kalshi returns settlement_value as "yes" or "no" for binary markets
        const settlementValue = market.settlement_value; // "yes" or "no"
        if (!settlementValue) {
          results.push({ ticker, status: "no_settlement_value" });
          continue;
        }

        // settlement_price: 100 for YES, 0 for NO (in cents)
        const settlementPriceCents = settlementValue === "yes" ? 100 : 0;

        // ── 4. Compute shadow PnL for each signal on this ticker ─────────────
        for (const sig of signals) {
          const entryPrice = sig.mid_price; // cents at signal time
          if (entryPrice === null || entryPrice === undefined) {
            continue; // can't compute PnL without entry price
          }

          let shadowPnlCents: number;
          if (sig.direction === "buy_yes") {
            // Bought YES at entryPrice: profit = settlement - entry
            shadowPnlCents = settlementPriceCents - entryPrice;
          } else if (sig.direction === "buy_no") {
            // Bought NO at entryPrice: NO price = 100 - YES price
            // Entry NO price = 100 - entryPrice
            // Settlement NO price = 100 - settlementPriceCents
            const entryNoPrice = 100 - entryPrice;
            const settlementNoPrice = 100 - settlementPriceCents;
            shadowPnlCents = settlementNoPrice - entryNoPrice;
          } else {
            continue; // skip direction
          }

          // Convert cents to dollars (1 contract)
          const shadowPnlDollars = shadowPnlCents / 100;

          await supabase.from("signals").update({
            shadow_pnl: shadowPnlDollars,
            settlement_price: settlementPriceCents,
            settled_at: new Date().toISOString(),
          }).eq("id", sig.id);

          settledCount++;
        }

        results.push({ ticker, status: "settled", settlement: settlementValue });

      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`Failed to settle ${ticker}:`, msg);
        results.push({ ticker, status: `error: ${msg}` });
      }
    }

    // ── 5. Log this run ──────────────────────────────────────────────────────
    await supabase.from("compliance_log").insert({
      event_type: "settle_signals_run",
      severity: "info",
      message: `Settle signals: ${settledCount} signals settled from ${results.length} markets checked`,
      metadata: { results, total_signals_checked: unsettledSignals.length },
    });

    return new Response(JSON.stringify({
      success: true,
      settled: settledCount,
      markets_checked: results.length,
      results: results.slice(0, 20), // truncate for response size
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("settle-signals error:", errMsg);

    try {
      await supabase.from("compliance_log").insert({
        event_type: "settle_signals_error",
        severity: "error",
        message: `settle-signals CRASHED: ${errMsg}`,
      });
    } catch { /* don't let the error handler throw */ }

    // Shadow PnL stops computing — Bayesian signal scores will stale out silently.
    await sendTelegramAlert(
      `⚠️ <b>[TradeAgent] settle-signals CRASHED</b>\n` +
      `Signal PnL attribution is not updating — confidence scores will degrade over time.\n` +
      `Error: ${errMsg.slice(0, 300)}`
    ).catch(() => {});

    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
