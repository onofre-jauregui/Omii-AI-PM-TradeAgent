import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import {
  computeBucketProbabilities,
  computeEdge,
  fetchForecast,
  type WeatherForecast,
  WEATHER_LOCATIONS,
} from "../_shared/weather.ts";

// ─── Weather market cache sync ────────────────────────────────────────────────

/**
 * Parse temperature bucket bounds from a Kalshi market.
 * Tries ticker suffix first (T65 → 65°F threshold), then title text patterns.
 * Returns null if no temperature range can be derived.
 */
function parseTempBucket(ticker: string, title: string): { low: number; high: number } | null {
  // Ticker suffix: KXHIGHNY-26APR15-T65 → threshold at 65°F
  const thresholdMatch = ticker.match(/-T(\d+)$/i);
  if (thresholdMatch) {
    const threshold = Number(thresholdMatch[1]);
    return { low: threshold, high: threshold + 5 };
  }

  const t = title.toLowerCase();

  // "between X and Y" / "X to Y degrees" / "X–Y°F" (range markets)
  let m = t.match(/between\s+(\d+)\s+and\s+(\d+)/i)
    || t.match(/(\d+)\s+to\s+(\d+)\s+(?:degrees|°|f\b)/i)
    || t.match(/(\d+)[–\-](\d+)\s*(?:degrees|°|f\b)/i);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };

  // "above X" / "at least X" / "over X" (open-ended upper threshold)
  m = t.match(/(?:above|at least|over|>=)\s+(\d+)/i);
  if (m) { const lo = Number(m[1]); return { low: lo, high: lo + 10 }; }

  // "below X" / "under X" / "less than X" (open-ended lower threshold)
  m = t.match(/(?:below|under|less than|<)\s+(\d+)/i);
  if (m) { const hi = Number(m[1]); return { low: hi - 10, high: hi }; }

  return null;
}

/**
 * Fetch Kalshi weather markets for a location and upsert into
 * weather_markets_cache. Called when the cache is empty for today.
 * Returns the number of rows successfully synced.
 */
async function syncWeatherMarkets(
  supabase: ReturnType<typeof createClient>,
  loc: (typeof WEATHER_LOCATIONS)[number],
  forecastDate: string,
): Promise<number> {
  let resp: Response;
  try {
    resp = await fetch(
      `${KALSHI_BASE_URL}/markets?limit=50&status=open&series_ticker=${loc.kalshiSeries}`,
    );
  } catch {
    return 0;
  }
  if (!resp.ok) return 0;

  const data = await resp.json().catch(() => ({}));
  const markets: any[] = data.markets || [];

  let synced = 0;
  for (const m of markets) {
    const title = m.title || m.subtitle || "";
    const bucket = parseTempBucket(m.ticker, title);
    if (!bucket) continue; // can't determine range — skip

    // Kalshi prices may come as dollars (0.65) or cents (65) depending on API version
    const toCents = (v: any) => {
      if (v == null) return null;
      const n = Number(v);
      return n > 1 ? Math.round(n) : Math.round(n * 100);
    };

    const { error } = await supabase.from("weather_markets_cache").upsert(
      {
        ticker: m.ticker,
        location: loc.code,
        forecast_date: forecastDate,
        bucket_low: bucket.low,
        bucket_high: bucket.high,
        yes_bid: toCents(m.yes_bid_dollars ?? m.yes_bid),
        yes_ask: toCents(m.yes_ask_dollars ?? m.yes_ask),
        last_price: toCents(m.last_price_dollars ?? m.last_price),
        market_question: title || m.ticker,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "ticker" },
    );
    if (!error) synced++;
  }
  return synced;
}

/**
 * weather-signal: Strategy S-005 signal generator.
 *
 * Pulls the National Weather Service hourly forecast for each Kalshi weather
 * city, computes a probability distribution over high-temperature buckets,
 * compares it to live Kalshi weather market prices, and writes signals into
 * the `signals` table for the auto-trade orchestrator to consume.
 *
 * Strategy backing (verified):
 *  - Kalshi weather markets settle on the NWS Daily Climate Report
 *    [Kalshi Help Center, verified]
 *  - NOAA / NWS publish forecast data publicly with no auth
 *    [api.weather.gov, verified]
 *  - Commercial tools (Kalshi Weather Edge) already exploit this delta
 *    [verified, but evidence the edge is real]
 *
 * Schedule: pg_cron every 30 minutes (configurable). Each run fetches one
 * forecast per location, caches it, and writes signals.
 *
 * IMPORTANT: this function never trades. It only writes signals. Trading
 * decisions go through auto-trade -> execute-trade as usual.
 */

const MIN_EDGE_TO_SIGNAL_CENTS = 5;

function signalStrength(edgeCents: number): "strong" | "moderate" | "weak" {
  if (edgeCents >= 15) return "strong";
  if (edgeCents >= 8) return "moderate";
  return "weak";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight("extended");

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
  const results: any[] = [];

  try {
    // 1. For each Kalshi weather city, fetch the forecast and cache it
    for (const loc of WEATHER_LOCATIONS) {
      const locResult: any = { location: loc.code, status: "pending" };

      try {
        const forecast = await fetchForecast(loc);

        // Cache the forecast for downstream backtests / debugging
        const { error: insertErr } = await supabase.from("weather_forecasts").insert({
          location: loc.code,
          forecast_date: forecast.forecastDate,
          source: forecast.source,
          high_temp_distribution: forecast.distribution,
          expected_high: forecast.expectedHigh,
          std_dev: forecast.stdDev,
          raw_payload: forecast.raw || null,
        });

        if (insertErr) {
          console.warn(`weather_forecasts insert failed for ${loc.code}:`, insertErr.message);
        }

        locResult.expected_high = forecast.expectedHigh;
        locResult.std_dev = forecast.stdDev;

        // 2. Read cached Kalshi weather markets for this location/date.
        //    If the cache is empty, sync from Kalshi first — weather-signal
        //    is self-contained and does not require a separate market sync step.
        let { data: markets } = await supabase
          .from("weather_markets_cache")
          .select("*")
          .eq("location", loc.code)
          .eq("forecast_date", forecast.forecastDate)
          .order("bucket_low");

        if (!markets || markets.length === 0) {
          const synced = await syncWeatherMarkets(supabase, loc, forecast.forecastDate);
          locResult.market_sync = synced;

          if (synced === 0) {
            locResult.status = "no_markets";
            locResult.note = `Kalshi has no open weather markets for ${loc.code} on ${forecast.forecastDate}`;
            results.push(locResult);
            continue;
          }

          // Re-read after sync
          const refetch = await supabase
            .from("weather_markets_cache")
            .select("*")
            .eq("location", loc.code)
            .eq("forecast_date", forecast.forecastDate)
            .order("bucket_low");
          markets = refetch.data;
        }

        if (!markets || markets.length === 0) {
          locResult.status = "no_markets";
          locResult.note = "No weather markets available after sync attempt";
          results.push(locResult);
          continue;
        }

        // 3. Compute bucket probabilities and find edge per market
        const bucketProbs = computeBucketProbabilities(forecast, markets);

        const signals: any[] = [];
        for (const m of markets) {
          const trueProb = bucketProbs.get(m.ticker);
          if (trueProb === undefined) continue;

          const edge = computeEdge(m, trueProb);
          if (Math.abs(edge.edgeCents) < MIN_EDGE_TO_SIGNAL_CENTS) continue;

          const edgeCentsAbs = Math.abs(edge.edgeCents);
          signals.push({
            ticker: m.ticker,
            market_question: m.market_question || `${loc.name} high temp ${m.bucket_low}-${m.bucket_high}°F`,
            direction: edge.direction,
            signal_strength: signalStrength(edgeCentsAbs),
            yes_bid: m.yes_bid,
            yes_ask: m.yes_ask,
            mid_price: m.yes_bid && m.yes_ask ? (m.yes_bid + m.yes_ask) / 2 : null,
            edge_cents: edgeCentsAbs,
            true_probability: trueProb,
            implied_probability: edge.impliedProb,
            liquidity_score: m.yes_bid && m.yes_ask ? Math.min(1, (100 - (m.yes_ask - m.yes_bid)) / 100) : 0,
            volume_rank_score: 0.7, // placeholder until volume sync exists
            time_value_score: 1.0,  // weather markets resolve same day → high urgency
            composite_score: Math.min(1, Math.abs(edge.edgeCents) / 20),
            days_to_close: 1,
            source: "weather_signal_s005",
            metadata: {
              location: loc.code,
              bucket_low: m.bucket_low,
              bucket_high: m.bucket_high,
              forecast_expected_high: forecast.expectedHigh,
              forecast_std_dev: forecast.stdDev,
              run_id: runId,
            },
          });
        }

        // 4. Insert signals (the auto-trade S-005 handler will pick them up)
        if (signals.length > 0) {
          const { error: sigErr } = await supabase.from("signals").insert(signals);
          if (sigErr) {
            console.error(`Signal insert failed for ${loc.code}:`, sigErr.message);
            locResult.status = "signal_insert_error";
            locResult.error = sigErr.message;
          } else {
            locResult.status = "completed";
            locResult.signals_written = signals.length;
            locResult.markets_evaluated = markets.length;
          }
        } else {
          locResult.status = "completed";
          locResult.signals_written = 0;
          locResult.markets_evaluated = markets.length;
          locResult.note = `No edge >= ${MIN_EDGE_TO_SIGNAL_CENTS}c found`;
        }
      } catch (e) {
        locResult.status = "error";
        locResult.error = e instanceof Error ? e.message : String(e);
        console.error(`weather-signal error for ${loc.code}:`, locResult.error);
      }

      results.push(locResult);
    }

    // 5. Log the run to compliance_log for observability
    await supabase.from("compliance_log").insert({
      event_type: "weather_signal_run",
      severity: "info",
      message: `weather-signal: ${results.filter(r => r.status === "completed").length}/${results.length} locations OK`,
      metadata: { run_id: runId, started_at: runStartedAt, results },
    });

    return new Response(
      JSON.stringify({ success: true, run_id: runId, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("weather-signal fatal error:", errMsg);
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
