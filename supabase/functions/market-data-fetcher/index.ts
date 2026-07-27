import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  KALSHI_BASE_URL,
  generateAuthHeaders,
  fetchWithRetry,
  getKalshiCredentials,
} from "../_shared/kalshi-auth.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

/**
 * market-data-fetcher: Sole Kalshi market data poller.
 *
 * Runs every 5 minutes via pg_cron. Fetches all series used by any downstream
 * consumer (surface-scanner, signal-generator, weather-signal) using authenticated
 * Kalshi requests (higher rate limit than unauthenticated public calls). Writes
 * all market data to kalshi_markets_cache. Consumers read from the cache — they
 * never call Kalshi directly for market data, which eliminates 429 rate-limit errors.
 *
 * Rate-limiting & circuit breaker:
 *   - 110ms spacing between requests → ≤9 req/sec, under Kalshi's 10 req/sec limit
 *   - Per-request 8s hard timeout via AbortSignal — no single request can hang the run
 *   - RUN_BUDGET_MS: if total elapsed exceeds 50s, skip remaining series and alert
 *   - CONSECUTIVE_FAILURE_LIMIT: 3 back-to-back failures → abort run and alert immediately
 *   - On abort: Telegram fires right then, not at next hourly health-check
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const KALSHI_REQUEST_SPACING_MS = 110;    // ≤9 req/sec between series
const REQUEST_TIMEOUT_MS = 8_000;         // abort any single request after 8s
const RUN_BUDGET_MS = 50_000;             // abort whole run after 50s (cron fires every 5min)
const CONSECUTIVE_FAILURE_LIMIT = 3;      // abort run if N failures in a row

// Full union of series needed by surface-scanner + signal-generator + weather-signal.
const SERIES = [
  // Macro / sports (long-horizon)
  "KXFED", "KXGDP", "KXPAYROLLS", "KXCPI",
  "KXINX", "KXBTC", "KXETH", "KXNHL", "KXNBA",
  "KXMLB", "KXCHCUTS",
  // Short-horizon daily markets
  "KXBTCD",    // daily BTC price ranges
  "KXETHD",    // daily ETH price ranges
  "KXHIGHNY",  // daily NYC high temp
  "KXHIGHCHI", // daily Chicago high temp
  "KXHIGHMIA", // daily Miami high temp
  "KXHIGHLAX", // daily LA high temp
  "KXHIGHAUS", // daily Austin high temp
];

serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const runStart = Date.now();
  const startedAt = new Date().toISOString();
  let totalMarkets = 0;
  const failedSeries: string[] = [];
  let skippedSeries: string[] = [];
  let consecutiveFailures = 0;
  let abortReason: string | null = null;

  const { keyId, privateKey } = await getKalshiCredentials(supabase, null);

  if (!keyId || !privateKey) {
    console.warn(
      "market-data-fetcher: Kalshi credentials not configured. " +
      "Running unauthenticated — rate limits are lower."
    );
  }

  for (const series of SERIES) {
    // ── Run budget check ──────────────────────────────────────────
    const elapsed = Date.now() - runStart;
    if (elapsed >= RUN_BUDGET_MS) {
      const remaining = SERIES.slice(SERIES.indexOf(series));
      skippedSeries = remaining;
      abortReason = `run budget exceeded (${(elapsed / 1000).toFixed(1)}s)`;
      break;
    }

    try {
      const path = `/trade-api/v2/markets?limit=100&status=open&series_ticker=${series}`;
      const url = `${KALSHI_BASE_URL}/markets?limit=100&status=open&series_ticker=${series}`;
      const timestamp = Date.now();

      let fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (keyId && privateKey) {
        fetchHeaders = await generateAuthHeaders(keyId, privateKey, "GET", path, timestamp);
      }

      // Per-request hard timeout — a hung Kalshi connection won't stall the whole run
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetchWithRetry(url, { headers: fetchHeaders, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      await sleep(KALSHI_REQUEST_SPACING_MS);

      if (!res.ok) {
        console.error(`market-data-fetcher: Kalshi ${res.status} for series ${series}`);
        failedSeries.push(series);
        consecutiveFailures++;

        const is429 = res.status === 429;
        await supabase.from("compliance_log").insert({
          event_type: "api_error",
          severity: is429 ? "warning" : "error",
          message: `market-data-fetcher: Kalshi ${res.status} on series ${series} (after retries)`,
          metadata: { series, status: res.status },
        });

        // Alert immediately on 429 — don't wait for hourly health-check
        if (is429) {
          await sendTelegramAlert(
            `⚠️ <b>[TradeAgent] Kalshi Rate Limit</b>\n` +
            `Series ${series} hit 429 after retries.\n` +
            `Market data for this series is stale until next cycle.`
          );
        }

        // ── Consecutive failure circuit breaker ──────────────────
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          const remaining = SERIES.slice(SERIES.indexOf(series) + 1);
          skippedSeries = remaining;
          abortReason = `${consecutiveFailures} consecutive failures`;
          break;
        }
        continue;
      }

      // Success — reset consecutive failure counter
      consecutiveFailures = 0;

      const data = await res.json();
      const markets: any[] = data.markets || [];

      if (markets.length === 0) continue;

      const rows = markets.map((m) => ({
        market_ticker: m.ticker,
        series_ticker: series,
        market_data: m,
        fetched_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase
        .from("kalshi_markets_cache")
        .upsert(rows, { onConflict: "market_ticker" });

      if (upsertErr) {
        console.error(`market-data-fetcher: cache upsert failed for ${series}:`, upsertErr.message);
        failedSeries.push(series);
        consecutiveFailures++;
      } else {
        totalMarkets += markets.length;
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = e instanceof Error && e.name === "AbortError";
      console.error(`market-data-fetcher: ${isTimeout ? "timeout" : "error"} on ${series}:`, msg);
      failedSeries.push(series);
      consecutiveFailures++;

      if (isTimeout) {
        await supabase.from("compliance_log").insert({
          event_type: "api_timeout",
          severity: "warning",
          message: `market-data-fetcher: request timeout on series ${series} (>${REQUEST_TIMEOUT_MS}ms)`,
          metadata: { series, timeout_ms: REQUEST_TIMEOUT_MS },
        });
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        const idx = SERIES.indexOf(series);
        skippedSeries = idx >= 0 ? SERIES.slice(idx + 1) : [];
        abortReason = `${consecutiveFailures} consecutive failures (last: ${isTimeout ? "timeout" : msg.slice(0, 60)})`;
        break;
      }
    }
  }

  // ── Alert immediately if run was aborted ─────────────────────────
  if (abortReason) {
    const msg =
      `🔴 <b>[TradeAgent] Market Data Fetcher Aborted</b>\n` +
      `Reason: ${abortReason}\n` +
      `${failedSeries.length} series failed, ${skippedSeries.length} skipped: ${skippedSeries.join(", ") || "none"}\n` +
      `Surface scanner and signal generation may be running on stale data.`;

    await Promise.all([
      sendTelegramAlert(msg),
      supabase.from("compliance_log").insert({
        event_type: "market_data_fetcher_aborted",
        severity: "critical",
        message: msg.replace(/<[^>]+>/g, ""),
        metadata: { abort_reason: abortReason, failed_series: failedSeries, skipped_series: skippedSeries },
      }),
    ]);
  }

  // Evict cache entries that weren't refreshed in this cycle (stale markets).
  // Rows with fetched_at older than 15 minutes are from markets no longer returned
  // by the Kalshi API — they're closed/settled and will cause phantom surface alerts.
  // Must also gate on skippedSeries: a run-budget abort leaves failedSeries empty
  // (nothing errored — the run just ran out of time) while skippedSeries holds every
  // series never attempted. Without this check, an abort cycle would delete live
  // cache rows for markets that are merely unrefreshed, not closed.
  if (failedSeries.length === 0 && skippedSeries.length === 0) {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    supabase.from("kalshi_markets_cache")
      .delete()
      .lt("fetched_at", fifteenMinAgo)
      .then()
      .catch((e: Error) => console.error("market-data-fetcher: cache eviction failed:", e.message));
  }

  const successSeries = SERIES.length - failedSeries.length - skippedSeries.length;
  await supabase.from("compliance_log").insert({
    event_type: "market_data_fetch",
    severity: failedSeries.length > 0 || skippedSeries.length > 0 ? "warning" : "info",
    message: `market-data-fetcher: ${successSeries}/${SERIES.length} series OK, ${totalMarkets} markets cached` +
      (skippedSeries.length > 0 ? ` (${skippedSeries.length} skipped — ${abortReason})` : ""),
    metadata: {
      started_at: startedAt,
      elapsed_ms: Date.now() - runStart,
      total_markets: totalMarkets,
      series_ok: successSeries,
      series_failed: failedSeries,
      series_skipped: skippedSeries,
      abort_reason: abortReason,
      authenticated: !!(keyId && privateKey),
    },
  });

  return new Response(
    JSON.stringify({
      success: failedSeries.length === 0 && skippedSeries.length === 0,
      series_fetched: successSeries,
      series_failed: failedSeries,
      series_skipped: skippedSeries,
      abort_reason: abortReason,
      total_markets_cached: totalMarkets,
      elapsed_ms: Date.now() - runStart,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
