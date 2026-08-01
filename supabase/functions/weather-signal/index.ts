import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { marketFieldCents } from "../_shared/kalshi-prices.ts";
import {
  computeBucketProbabilities,
  computeEdge,
  fetchForecast,
  type WeatherForecast,
  WEATHER_LOCATIONS,
} from "../_shared/weather.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

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
    const tl = title.toLowerCase();
    // Detect "YES if high < threshold" markets from title language
    const hasBelow = /<\s*\d|less than|below|under/.test(tl);
    const hasAbove = />\s*\d|at least|over\s|\babove\b/.test(tl);
    if (hasBelow && !hasAbove) {
      // YES = high < threshold → P(high in (-inf, threshold))
      return { low: -999, high: threshold };
    }
    // Default: YES = high >= threshold → P(high in [threshold, +inf))
    return { low: threshold, high: 9999 };
  }

  const t = title.toLowerCase();

  // "between X and Y" / "X to Y degrees" / "X–Y°F" (range markets)
  let m = t.match(/between\s+(\d+)\s+and\s+(\d+)/i)
    || t.match(/(\d+)\s+to\s+(\d+)\s+(?:degrees|°|f\b)/i)
    || t.match(/(\d+)[–\-](\d+)\s*(?:degrees|°|f\b)/i);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };

  // "above X" / "at least X" / "over X" (open-ended upper threshold)
  m = t.match(/(?:above|at least|over|>=)\s+(\d+)/i);
  if (m) { const lo = Number(m[1]); return { low: lo, high: 9999 }; }

  // "below X" / "under X" / "less than X" (open-ended lower threshold)
  m = t.match(/(?:below|under|less than|<)\s+(\d+)/i);
  if (m) { const hi = Number(m[1]); return { low: -999, high: hi }; }

  return null;
}

/**
 * Sync Kalshi weather markets from kalshi_markets_cache into weather_markets_cache.
 * Called when the weather cache is empty for today. Reads from the shared market
 * cache (written by market-data-fetcher) rather than calling Kalshi directly.
 * Returns the number of rows successfully synced.
 */
async function syncWeatherMarkets(
  supabase: ReturnType<typeof createClient>,
  loc: (typeof WEATHER_LOCATIONS)[number],
  forecastDate: string,
): Promise<number> {
  // Read from the shared cache populated by market-data-fetcher.
  const { data: cacheRows, error: cacheErr } = await supabase
    .from("kalshi_markets_cache")
    .select("market_data")
    .eq("series_ticker", loc.kalshiSeries);

  if (cacheErr || !cacheRows || cacheRows.length === 0) return 0;

  const markets: any[] = cacheRows.map((r) => r.market_data);

  let synced = 0;
  for (const m of markets) {
    const title = m.title || m.subtitle || "";
    const bucket = parseTempBucket(m.ticker, title);
    if (!bucket) continue; // can't determine range — skip


    const { error } = await supabase.from("weather_markets_cache").upsert(
      {
        ticker: m.ticker,
        location: loc.code,
        forecast_date: forecastDate,
        bucket_low: bucket.low,
        bucket_high: bucket.high,
        // Canonical converter (never magnitude-guess — the old local toCents
        // mis-parsed a literal 1c as 100c). See _shared/kalshi-prices.ts.
        yes_bid: marketFieldCents(m, "yes_bid"),
        yes_ask: marketFieldCents(m, "yes_ask"),
        last_price: marketFieldCents(m, "last_price"),
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

// Backtest (weather_replay, ERA5 ground truth) showed 15¢ threshold hits 48.9%
// win rate vs 38.1% at 5¢. Profitable at all thresholds due to asymmetric
// payouts, but 15¢ maximizes risk-adjusted edge.
const MIN_EDGE_TO_SIGNAL_CENTS = 25;

// AUS and CHI show 22-23% win rates vs LAX 45%, NYC/MIA ~38%.
// GFS underperforms on continental convective weather — exclude until
// calibration has ≥30 samples to correct the bias.
const EXCLUDED_LOCATIONS = new Set(["AUS", "CHI"]);

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
    // 0. Load per-city GFS bias corrections from backtest-weather calibration.
    //    If table is empty or unavailable, defaults to 0 (no correction).
    const { data: calibRows } = await supabase
      .from("weather_calibration")
      .select("location, bias_fahrenheit, rmse_fahrenheit, sample_count");
    const calibration = new Map<string, { bias: number; rmse: number; samples: number }>(
      (calibRows || []).map((r: any) => [r.location, {
        bias: r.bias_fahrenheit ?? 0,
        rmse: r.rmse_fahrenheit ?? 0,
        samples: r.sample_count ?? 0,
      }])
    );

    // 1. For each Kalshi weather city, fetch the forecast and cache it
    for (const loc of WEATHER_LOCATIONS) {
      if (EXCLUDED_LOCATIONS.has(loc.code)) {
        results.push({ location: loc.code, status: "skipped", note: "excluded — low win rate in backtest" });
        continue;
      }
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

        // 3. Apply bias calibration and RMSE-based uncertainty widening.
        //
        //    GFS ensemble spread (stdDev from member variance) measures internal
        //    model agreement — NOT forecast accuracy. When all 31 members agree on
        //    a warm day but a cold front arrives, ensemble spread stays tight while
        //    the actual error is 5-8°F. Using spread alone produces overconfident
        //    probability estimates and fabricated edges.
        //
        //    effectiveStdDev = max(ensemble_spread, calibration_rmse, 3.5)
        //      - calibration_rmse: empirical error from backtest-weather vs ERA5
        //      - 3.5°F floor: typical 24hr GFS RMSE across US cities (conservative prior)
        //    Requires ≥ 5 samples before trusting calibration RMSE.
        const cal = calibration.get(loc.code);
        const biasCorrection = (cal && cal.samples >= 5) ? cal.bias : 0;
        const calibrationRmse = (cal && cal.samples >= 5) ? cal.rmse : 0;
        const effectiveStdDev = Math.max(forecast.stdDev, calibrationRmse, 3.5);

        const calibratedExpectedHigh = biasCorrection !== 0
          ? Math.round((forecast.expectedHigh - biasCorrection) * 10) / 10
          : forecast.expectedHigh;

        // 3b. Fetch ECMWF via Open-Meteo as a second forecast source.
        //     ECMWF IFS 0.25° returns a deterministic point estimate — used as
        //     a consensus check against the GFS ensemble mean.
        let ecmwfExpectedHighF: number | null = null;
        try {
          const ecmwfResp = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max&models=ecmwf_ifs025&timezone=auto&forecast_days=3`,
            { signal: AbortSignal.timeout(8_000) }
          );
          if (ecmwfResp.ok) {
            const ecmwfData = await ecmwfResp.json().catch(() => null);
            const ecmwfHighC = ecmwfData?.daily?.temperature_2m_max?.[0];
            if (ecmwfHighC != null && !isNaN(Number(ecmwfHighC))) {
              ecmwfExpectedHighF = Math.round(((Number(ecmwfHighC) * 9) / 5 + 32) * 10) / 10;
            }
          }
        } catch (ecmwfErr) {
          const ecmwfMsg = ecmwfErr instanceof Error ? ecmwfErr.message : String(ecmwfErr);
          console.warn(`ECMWF fetch failed for ${loc.code}:`, ecmwfMsg);
          await supabase.from("compliance_log").insert({
            event_type: "api_error",
            severity: "warning",
            message: `weather-signal: open-meteo ECMWF fetch failed for ${loc.code}: ${ecmwfMsg.slice(0, 120)}`,
            metadata: { provider: "open-meteo", city: loc.code, error: ecmwfMsg },
          }).then(undefined, () => {});
        }

        // Dual-model consensus: adjust effective edge based on model agreement
        let confidenceMultiplier = 1.0;
        const modelAgreementF = ecmwfExpectedHighF !== null
          ? Math.abs(calibratedExpectedHigh - ecmwfExpectedHighF)
          : null;

        if (modelAgreementF !== null) {
          if (modelAgreementF <= 1.5) {
            confidenceMultiplier = 1.2;
          } else if (modelAgreementF > 3.0) {
            confidenceMultiplier = 0.8;
          }
        }

        const calibratedForecast = {
          ...forecast,
          expectedHigh: calibratedExpectedHigh,
          stdDev: Math.round(effectiveStdDev * 10) / 10,
        };

        const bucketProbs = computeBucketProbabilities(calibratedForecast, markets);

        const signals: any[] = [];
        for (const m of markets) {
          // Skip settled markets — yes_bid >= 95 or yes_ask <= 5 means
          // the contract has already resolved (or is trading as if it has).
          if ((m.yes_bid ?? 0) >= 90 || (m.yes_ask ?? 100) <= 10) continue;

          const trueProb = bucketProbs.get(m.ticker);
          if (trueProb === undefined) continue;

          const edge = computeEdge(m, trueProb);
          const rawEdgeCents = Math.abs(edge.edgeCents);
          // Skip extreme model-vs-market disagreements where the market is likely right.
          // A claimed 65¢+ edge against a market side priced above 50¢ indicates the GFS
          // missed an event (e.g., heat wave). Trust the market in these cases.
          if (rawEdgeCents > 65) {
            const opposingMarketConfidence = edge.direction === 'buy_yes'
              ? (m.yes_ask != null ? 100 - m.yes_ask : 0)   // NO side price
              : (m.yes_bid ?? 0);                             // YES side price
            if (opposingMarketConfidence > 50) continue; // market strongly disagrees — skip
          }
          // Apply dual-model confidence multiplier: if models disagree, require larger edge
          const effectiveEdge = rawEdgeCents * confidenceMultiplier;
          if (effectiveEdge < MIN_EDGE_TO_SIGNAL_CENTS) continue;

          signals.push({
            ticker: m.ticker,
            market_question: m.market_question || `${loc.name} high temp ${m.bucket_low}-${m.bucket_high}°F`,
            direction: edge.direction,
            signal_strength: signalStrength(Math.round(effectiveEdge)),
            yes_bid: m.yes_bid,
            yes_ask: m.yes_ask,
            mid_price: m.yes_bid && m.yes_ask ? Math.round((m.yes_bid + m.yes_ask) / 2) : null,
            edge_cents: Math.round(effectiveEdge),
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
              calibrated_expected_high: calibratedForecast.expectedHigh,
              bias_correction_applied: biasCorrection,
              calibration_rmse: calibrationRmse,
              ensemble_std_dev: forecast.stdDev,
              effective_std_dev: calibratedForecast.stdDev,
              calibration_samples: cal?.samples ?? 0,
              forecast_std_dev: calibratedForecast.stdDev,
              ecmwf_expected_high: ecmwfExpectedHighF,
              model_agreement_f: modelAgreementF,
              raw_edge_cents: Math.round(rawEdgeCents),
              confidence_multiplier: confidenceMultiplier,
              run_id: runId,
            },
          });
        }

        // 4. Upsert signals — one live row per ticker per source, updated each run
        if (signals.length > 0) {
          const { error: sigErr } = await supabase.from("signals").upsert(signals, {
            onConflict: "ticker,source",
            ignoreDuplicates: false,
          });
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

    // S-005 signals stop flowing silently without this alert — auto-trade will
    // return "no weather signals" which looks identical to a normal low-edge day.
    try {
      await supabase.from("compliance_log").insert({
        event_type: "weather_signal_crash",
        severity: "critical",
        message: `weather-signal CRASHED: ${errMsg}`,
      });
    } catch { /* don't let the error handler throw */ }

    await sendTelegramAlert(
      `🚨 <b>[TradeAgent] weather-signal CRASHED</b>\n` +
      `S-005 weather signals are not being generated — auto-trade will silently skip weather entries.\n` +
      `Error: ${errMsg.slice(0, 300)}`
    ).catch(() => {});

    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
