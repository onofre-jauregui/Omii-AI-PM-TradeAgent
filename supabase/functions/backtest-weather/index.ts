import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { WEATHER_LOCATIONS } from "../_shared/weather.ts";

/**
 * backtest-weather: Calibrates GFS forecast bias per city.
 *
 * For each Kalshi weather city, fetches 30+ days of:
 *  1. Actual observed daily highs — Open-Meteo archive (ERA5 reanalysis, best
 *     available ground-truth proxy for NWS climate station reports)
 *  2. GFS ensemble hindcast — Open-Meteo ensemble API with historical dates
 *     (the same 31-member GEFS data our live signal uses, but for past days)
 *
 * Computes per-city:
 *  - bias = mean(GFS_mean - actual)   — positive means model runs warm
 *  - RMSE = sqrt(mean((GFS - actual)²))
 *  - MAD  = median(|GFS - actual|)    — robust to storm outliers
 *
 * Upserts results to weather_calibration. weather-signal reads this table and
 * subtracts bias from expectedHigh before computing bucket probabilities.
 *
 * Call manually or schedule daily via pg_cron.
 *
 * Query param: ?days=30  (default 30, max 90 — Open-Meteo archive limit)
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

// Neither Open-Meteo call below had a timeout — a stalled request for any one city in the
// loop blocked this once-daily cron for every remaining city, up to the platform's own
// execution timeout. Same bound as the rest of the timeout-guard campaign.
const FETCH_TIMEOUT_MS = 8_000;

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({ error: "Missing Supabase credentials" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const url = new URL(req.url);
  const days = Math.min(
    MAX_DAYS,
    Math.max(
      7,
      parseInt(url.searchParams.get("days") || String(DEFAULT_DAYS), 10),
    ),
  );

  // Date range: [days] days ago → yesterday (exclude today — not yet settled)
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));

  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  const locationResults: any[] = [];

  for (const loc of WEATHER_LOCATIONS) {
    const locResult: any = {
      location: loc.code,
      status: "pending",
      date_range: `${startStr} → ${endStr}`,
    };

    try {
      // ── 1. Actual observed highs (ERA5-based reanalysis) ──────────────────
      const archiveParams = new URLSearchParams({
        latitude: String(loc.lat),
        longitude: String(loc.lon),
        start_date: startStr,
        end_date: endStr,
        daily: "temperature_2m_max",
        temperature_unit: "fahrenheit",
        timezone: loc.timezone,
      });
      const archiveController = new AbortController();
      const archiveTimeoutId = setTimeout(
        () => archiveController.abort(),
        FETCH_TIMEOUT_MS,
      );
      let archiveResp: Response;
      try {
        archiveResp = await fetch(
          `https://archive-api.open-meteo.com/v1/archive?${archiveParams}`,
          {
            headers: {
              "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)",
            },
            signal: archiveController.signal,
          },
        );
      } finally {
        clearTimeout(archiveTimeoutId);
      }
      if (!archiveResp.ok) {
        throw new Error(`Archive API ${archiveResp.status} for ${loc.code}`);
      }

      const archiveData = await archiveResp.json();
      const actualByDate: Record<string, number> = {};
      const archiveDates: string[] = archiveData.daily?.time || [];
      const archiveTemps: (number | null)[] =
        archiveData.daily?.temperature_2m_max || [];
      for (let i = 0; i < archiveDates.length; i++) {
        if (archiveTemps[i] != null) {
          actualByDate[archiveDates[i]] = archiveTemps[i]!;
        }
      }

      // ── 2. GFS ensemble hindcast ──────────────────────────────────────────
      const ensParams = new URLSearchParams({
        latitude: String(loc.lat),
        longitude: String(loc.lon),
        start_date: startStr,
        end_date: endStr,
        daily: "temperature_2m_max",
        models: "gfs_seamless",
        temperature_unit: "fahrenheit",
        timezone: loc.timezone,
      });
      const ensController = new AbortController();
      const ensTimeoutId = setTimeout(
        () => ensController.abort(),
        FETCH_TIMEOUT_MS,
      );
      let ensResp: Response;
      try {
        ensResp = await fetch(
          `https://ensemble-api.open-meteo.com/v1/ensemble?${ensParams}`,
          {
            headers: {
              "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)",
            },
            signal: ensController.signal,
          },
        );
      } finally {
        clearTimeout(ensTimeoutId);
      }
      if (!ensResp.ok) {
        throw new Error(`Ensemble API ${ensResp.status} for ${loc.code}`);
      }

      const ensData = await ensResp.json();
      const gfsMeanByDate: Record<string, number> = {};
      const ensDates: string[] = ensData.daily?.time || [];
      const memberKeys = Object.keys(ensData.daily || {}).filter((k) =>
        k.startsWith("temperature_2m_max_member")
      );
      console.log(
        `[${loc.code}] GFS ensemble dates: ${ensDates.length}, members: ${memberKeys.length}`,
      );

      for (let i = 0; i < ensDates.length; i++) {
        const date = ensDates[i];
        const memberVals: number[] = [];
        for (const key of memberKeys) {
          const val = ensData.daily[key][i];
          if (val != null && !isNaN(val)) memberVals.push(val);
        }
        // Fallback: some historical responses return only temperature_2m_max (mean)
        if (
          memberVals.length === 0 &&
          ensData.daily?.temperature_2m_max?.[i] != null
        ) {
          memberVals.push(ensData.daily.temperature_2m_max[i]);
        }
        if (memberVals.length > 0) {
          gfsMeanByDate[date] = memberVals.reduce((a, b) => a + b, 0) /
            memberVals.length;
        }
      }

      // ── 3. Also pull stored forecasts from our own weather_forecasts table ─
      //    These are real live forecasts made before the day resolved — higher
      //    quality signal than hindcasts for bias computation.
      const { data: storedForecasts } = await supabase
        .from("weather_forecasts")
        .select("forecast_date, expected_high")
        .eq("location", loc.code)
        .gte("forecast_date", startStr)
        .lte("forecast_date", endStr)
        .order("forecast_date");

      // Where we have our own stored forecast, prefer it over GFS hindcast
      const forecastByDate: Record<string, number> = { ...gfsMeanByDate };
      for (const row of storedForecasts || []) {
        if (row.expected_high != null) {
          forecastByDate[row.forecast_date] = row.expected_high;
        }
      }

      // ── 4. Compute errors ─────────────────────────────────────────────────
      const errors: number[] = [];
      const dailyErrors: {
        date: string;
        gfs: number;
        actual: number;
        error: number;
      }[] = [];

      for (const date of Object.keys(actualByDate).sort()) {
        const gfs = forecastByDate[date];
        const actual = actualByDate[date];
        if (gfs != null && actual != null) {
          const err = gfs - actual; // positive = GFS warmer than reality
          errors.push(err);
          dailyErrors.push({
            date,
            gfs: Math.round(gfs * 10) / 10,
            actual: Math.round(actual * 10) / 10,
            error: Math.round(err * 10) / 10,
          });
        }
      }

      if (errors.length < 3) {
        locResult.status = "insufficient_data";
        locResult.note = `Only ${errors.length} overlap days — need ≥ 3`;
        locResult.sample_count = errors.length;
        locationResults.push(locResult);
        continue;
      }

      const bias = errors.reduce((a, b) => a + b, 0) / errors.length;
      const rmse = Math.sqrt(
        errors.reduce((s, e) => s + e * e, 0) / errors.length,
      );
      const sorted = [...errors.map(Math.abs)].sort((a, b) => a - b);
      const mad = sorted[Math.floor(sorted.length / 2)]; // median absolute deviation

      // ── 5. Upsert calibration ─────────────────────────────────────────────
      await supabase.from("weather_calibration").upsert({
        location: loc.code,
        bias_fahrenheit: Math.round(bias * 100) / 100,
        rmse_fahrenheit: Math.round(rmse * 100) / 100,
        mad_fahrenheit: Math.round(mad * 100) / 100,
        sample_count: errors.length,
        date_range_start: startStr,
        date_range_end: endStr,
        model_source: (storedForecasts?.length ?? 0) > 0
          ? "gfs_ensemble_mixed_live"
          : "gfs_ensemble_hindcast",
        last_backtest_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "location" });

      // ── 6. Write a memory so the agent learns from this ───────────────────
      if (Math.abs(bias) >= 1.0) {
        const direction = bias > 0
          ? "warm (forecasts too high)"
          : "cold (forecasts too low)";
        await supabase.from("agent_memory").insert({
          memory_type: "market_condition",
          title: `GFS bias for ${loc.name}: ${bias > 0 ? "+" : ""}${
            bias.toFixed(1)
          }°F`,
          content: `GFS ensemble runs ${direction} for ${loc.name} by ${
            Math.abs(bias).toFixed(1)
          }°F on average (RMSE: ${rmse.toFixed(1)}°F, MAD: ${
            mad.toFixed(1)
          }°F, n=${errors.length} days). Apply bias correction: subtract ${
            bias.toFixed(1)
          }°F from forecast before computing edge.`,
          source_type: "backtest",
          tags: [
            loc.code.toLowerCase(),
            "weather",
            "gfs",
            "calibration",
            "bias",
          ],
          confidence: Math.min(0.9, errors.length / 30),
          strategy_id: "S-005",
        });
      }

      locResult.status = "completed";
      locResult.sample_count = errors.length;
      locResult.bias_fahrenheit = Math.round(bias * 10) / 10;
      locResult.rmse_fahrenheit = Math.round(rmse * 10) / 10;
      locResult.mad_fahrenheit = Math.round(mad * 10) / 10;
      locResult.live_forecasts_used = storedForecasts?.length ?? 0;
      locResult.interpretation = bias > 1
        ? `GFS runs warm — calibration will lower threshold by ${
          Math.abs(bias).toFixed(1)
        }°F`
        : bias < -1
        ? `GFS runs cold — calibration will raise threshold by ${
          Math.abs(bias).toFixed(1)
        }°F`
        : "GFS well-calibrated for this city (bias < 1°F)";
      locResult.daily_errors = dailyErrors.slice(-7); // last 7 days for inspection
    } catch (e) {
      locResult.status = "error";
      locResult.error = e instanceof Error ? e.message : String(e);
      console.error(`backtest-weather error for ${loc.code}:`, locResult.error);
    }

    locationResults.push(locResult);
  }

  await supabase.from("compliance_log").insert({
    event_type: "weather_backtest_run",
    severity: "info",
    message: `backtest-weather: ${
      locationResults.filter((r) => r.status === "completed").length
    }/${locationResults.length} cities calibrated over ${days} days`,
    metadata: {
      date_range: `${startStr} → ${endStr}`,
      results: locationResults,
    },
  });

  return new Response(
    JSON.stringify({
      success: true,
      days,
      date_range: `${startStr} → ${endStr}`,
      locations: locationResults,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
