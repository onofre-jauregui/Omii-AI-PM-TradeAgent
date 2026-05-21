import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  KALSHI_BASE_URL,
  generateAuthHeaders,
  fetchWithRetry,
  getKalshiCredentials,
} from "../_shared/kalshi-auth.ts";

/**
 * market-data-fetcher: Sole Kalshi market data poller.
 *
 * Runs every 5 minutes via pg_cron. Fetches all series used by any downstream
 * consumer (surface-scanner, signal-generator, weather-signal) using authenticated
 * Kalshi requests (higher rate limit than unauthenticated public calls). Writes
 * all market data to kalshi_markets_cache. Consumers read from the cache — they
 * never call Kalshi directly for market data, which eliminates 429 rate-limit errors.
 *
 * Rate limit math:
 *   - 18 series × 1 request = 18 authenticated calls per 5-min cycle (~216/hr)
 *   - Authenticated tier limit is far above this (Kalshi: ~10k+ requests/hr for live users)
 *   - Previous pattern: 3 functions × ~11 calls each = 33 unauthenticated calls per run,
 *     all sharing the same IP pool and unauthenticated rate limit bucket
 */

// Full union of series needed by surface-scanner + signal-generator + weather-signal.
// Signal-generator's list is the superset.
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

  const startedAt = new Date().toISOString();
  let totalMarkets = 0;
  let failedSeries: string[] = [];

  // Load server-wide Kalshi credentials (env vars, not per-user keys).
  // market-data-fetcher is a platform-level operation.
  const { keyId, privateKey } = await getKalshiCredentials(supabase, null);

  if (!keyId || !privateKey) {
    // Credentials not configured — fall back to unauthenticated (lower rate limit)
    // and log a warning so the operator knows to fix this.
    console.warn(
      "market-data-fetcher: Kalshi credentials not configured. " +
      "Running unauthenticated — rate limits are lower. " +
      "Set KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY in Supabase secrets."
    );
  }

  for (const series of SERIES) {
    try {
      const path = `/trade-api/v2/markets?limit=100&status=open&series_ticker=${series}`;
      const url = `${KALSHI_BASE_URL}/markets?limit=100&status=open&series_ticker=${series}`;
      const timestamp = Math.floor(Date.now() / 1000);

      let fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (keyId && privateKey) {
        fetchHeaders = await generateAuthHeaders(keyId, privateKey, "GET", path, timestamp);
      }

      const res = await fetchWithRetry(url, { headers: fetchHeaders });

      if (!res.ok) {
        console.error(`market-data-fetcher: Kalshi ${res.status} for series ${series}`);
        failedSeries.push(series);
        await supabase.from("compliance_log").insert({
          event_type: "api_error",
          severity: res.status === 429 ? "warning" : "error",
          message: `market-data-fetcher: Kalshi ${res.status} on series ${series} (after retries)`,
          metadata: { series, status: res.status },
        });
        continue;
      }

      const data = await res.json();
      const markets: any[] = data.markets || [];

      if (markets.length === 0) continue;

      // Upsert each market into the cache. market_ticker is the PK so existing rows
      // are overwritten with fresh data. fetched_at updates automatically.
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
      } else {
        totalMarkets += markets.length;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`market-data-fetcher: error fetching ${series}:`, msg);
      failedSeries.push(series);
    }
  }

  const successSeries = SERIES.length - failedSeries.length;
  await supabase.from("compliance_log").insert({
    event_type: "market_data_fetch",
    severity: failedSeries.length > 0 ? "warning" : "info",
    message: `market-data-fetcher: ${successSeries}/${SERIES.length} series OK, ${totalMarkets} markets cached`,
    metadata: {
      started_at: startedAt,
      total_markets: totalMarkets,
      series_ok: successSeries,
      series_failed: failedSeries,
      authenticated: !!(keyId && privateKey),
    },
  });

  return new Response(
    JSON.stringify({
      success: failedSeries.length === 0,
      series_fetched: successSeries,
      series_failed: failedSeries,
      total_markets_cached: totalMarkets,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
