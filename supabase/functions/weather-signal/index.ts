import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import {
  computeBucketProbabilities,
  computeEdge,
  fetchNwsForecast,
  type WeatherForecast,
  WEATHER_LOCATIONS,
} from "../_shared/weather.ts";

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
const MIN_LIQUIDITY_SCORE = 0.2;

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
        const forecast = await fetchNwsForecast(loc);

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

        // 2. Read cached Kalshi weather markets for this location/date
        const { data: markets } = await supabase
          .from("weather_markets_cache")
          .select("*")
          .eq("location", loc.code)
          .eq("forecast_date", forecast.forecastDate)
          .order("bucket_low");

        if (!markets || markets.length === 0) {
          locResult.status = "no_markets";
          locResult.note = "No cached weather markets for this date — run market sync first";
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

          signals.push({
            ticker: m.ticker,
            market_question: m.market_question || `${loc.name} high temp ${m.bucket_low}-${m.bucket_high}°F`,
            direction: edge.direction,
            yes_bid: m.yes_bid,
            yes_ask: m.yes_ask,
            mid_price: m.yes_bid && m.yes_ask ? (m.yes_bid + m.yes_ask) / 2 : null,
            edge_cents: Math.abs(edge.edgeCents),
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
