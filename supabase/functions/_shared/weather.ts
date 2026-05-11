/**
 * Weather forecasting math for the S-005 weather strategy.
 *
 * Pure functions here — no I/O except the explicit fetch helpers at the bottom.
 * Everything else is deterministic and unit-testable.
 *
 * Forecast hierarchy (best-to-fallback):
 *  1. GFS 31-member ensemble via Open-Meteo (free, no auth, better uncertainty)
 *  2. NWS hourly point forecast (fallback when Open-Meteo is unavailable)
 *
 * Strategy backing:
 *  - Kalshi weather markets settle on the NWS Daily Climate Report [verified]
 *  - Open-Meteo serves GFS ensemble data freely at ensemble-api.open-meteo.com [verified]
 *  - GFS seamless ensemble has 31 members, daily temperature_2m_max per member [verified]
 */

// ─── Locations Kalshi runs daily weather markets for ──────────────────────────

export interface WeatherLocation {
  code: string;
  name: string;
  /** NWS gridpoint for fallback hourly forecast. Format: WFO/X,Y */
  nwsGridpoint: string;
  /** Climate station Kalshi uses for settlement */
  climateStation: string;
  /** Kalshi series ticker */
  kalshiSeries: string;
  /** Latitude of the climate station (for GFS ensemble fetch) */
  lat: number;
  /** Longitude of the climate station (for GFS ensemble fetch) */
  lon: number;
  /** IANA timezone string for the station */
  timezone: string;
}

export const WEATHER_LOCATIONS: WeatherLocation[] = [
  {
    code: "NYC",
    name: "New York City",
    nwsGridpoint: "OKX/33,37",
    climateStation: "KNYC",
    kalshiSeries: "KXHIGHNY",
    lat: 40.7789,
    lon: -73.9692,
    timezone: "America/New_York",
  },
  {
    code: "CHI",
    name: "Chicago",
    nwsGridpoint: "LOT/76,73",
    climateStation: "KORD",
    kalshiSeries: "KXHIGHCHI",
    lat: 41.9796,
    lon: -87.9046,
    timezone: "America/Chicago",
  },
  {
    code: "MIA",
    name: "Miami",
    nwsGridpoint: "MFL/110,50",
    climateStation: "KMIA",
    kalshiSeries: "KXHIGHMIA",
    lat: 25.7959,
    lon: -80.2870,
    timezone: "America/New_York",
  },
  {
    code: "LAX",
    name: "Los Angeles",
    nwsGridpoint: "LOX/151,13",
    climateStation: "KLAX",
    kalshiSeries: "KXHIGHLAX",
    lat: 33.9425,
    lon: -118.4081,
    timezone: "America/Los_Angeles",
  },
  {
    code: "AUS",
    name: "Austin",
    nwsGridpoint: "EWX/156,91",
    climateStation: "KAUS",
    kalshiSeries: "KXHIGHAUS",
    lat: 30.1945,
    lon: -97.6699,
    timezone: "America/Chicago",
  },
];

// ─── Forecast data shape ──────────────────────────────────────────────────────

export interface WeatherForecast {
  location: string;
  forecastDate: string; // ISO date (YYYY-MM-DD) for the day the high temp will occur
  source: string;
  /** Mean of the temperature distribution (degrees F) */
  expectedHigh: number;
  /** Standard deviation of the distribution (degrees F) */
  stdDev: number;
  /**
   * Bucketed probability distribution: { "65-70": 0.35, ... }
   * Buckets are 5°F spans. Caller can re-bucket for different Kalshi boundaries.
   */
  distribution: Record<string, number>;
  raw?: any;
}

// ─── Pure math: normal CDF and PDF ───────────────────────────────────────────

/** Standard normal CDF (Abramowitz & Stegun approximation, max error ~1.5e-7) */
export function normalCdf(x: number, mean = 0, stdDev = 1): number {
  if (stdDev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stdDev * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Probability that the daily high falls in [low, high) given a normal
 * distribution with the given mean and std dev.
 */
export function bucketProbability(
  low: number,
  high: number,
  mean: number,
  stdDev: number,
): number {
  return Math.max(0, Math.min(1, normalCdf(high, mean, stdDev) - normalCdf(low, mean, stdDev)));
}

// ─── Bucket probability computation for a set of Kalshi markets ──────────────

export interface KalshiWeatherMarket {
  ticker: string;
  bucket_low: number;
  bucket_high: number;
  yes_bid?: number | null;
  yes_ask?: number | null;
  market_question?: string | null;
}

export function computeBucketProbabilities(
  forecast: WeatherForecast,
  markets: KalshiWeatherMarket[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of markets) {
    out.set(m.ticker, bucketProbability(m.bucket_low, m.bucket_high, forecast.expectedHigh, forecast.stdDev));
  }
  return out;
}

// ─── Edge calculation ─────────────────────────────────────────────────────────

export interface EdgeResult {
  direction: "buy_yes" | "buy_no" | "skip";
  trueProb: number;
  impliedProb: number;
  edgeCents: number;
}

export function computeEdge(market: KalshiWeatherMarket, trueProb: number): EdgeResult {
  const yesAsk = market.yes_ask;
  const yesBid = market.yes_bid;

  if (yesAsk == null && yesBid == null) {
    return { direction: "skip", trueProb, impliedProb: NaN, edgeCents: 0 };
  }

  const mid = yesAsk != null && yesBid != null
    ? (yesAsk + yesBid) / 2
    : yesAsk ?? yesBid ?? 50;
  const impliedProb = mid / 100;
  const trueProbCents = trueProb * 100;

  const buyYesEdge = trueProbCents - (yesAsk ?? mid);
  const buyNoEdge = (yesBid ?? mid) - trueProbCents;

  if (buyYesEdge >= buyNoEdge && buyYesEdge > 0) {
    return { direction: "buy_yes", trueProb, impliedProb, edgeCents: buyYesEdge };
  }
  if (buyNoEdge > 0) {
    return { direction: "buy_no", trueProb, impliedProb, edgeCents: buyNoEdge };
  }
  return { direction: "skip", trueProb, impliedProb, edgeCents: 0 };
}

// ─── Forecast fetchers ────────────────────────────────────────────────────────

/**
 * Primary: GFS 31-member ensemble via Open-Meteo.
 *
 * Uses daily temperature_2m_max per member — one value per member per day,
 * no hourly parsing needed. The 31-member spread gives a genuine uncertainty
 * estimate rather than a proxy computed from the hourly NWS spread.
 *
 * Open-Meteo is free, unauthenticated, and has no rate limits for reasonable use.
 */
export async function fetchGfsEnsembleForecast(
  location: WeatherLocation,
): Promise<WeatherForecast> {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    daily: "temperature_2m_max",
    models: "gfs_seamless",
    temperature_unit: "fahrenheit",
    timezone: location.timezone,
    forecast_days: "2",
  });

  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?${params}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)" },
  });

  if (!resp.ok) {
    throw new Error(`Open-Meteo GFS ensemble failed for ${location.code}: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  const daily = data?.daily;
  if (!daily) throw new Error(`Open-Meteo: no daily data for ${location.code}`);

  // today's date in the station's local timezone
  const forecastDate = new Date().toLocaleDateString("en-CA", { timeZone: location.timezone });
  const dateIndex = (daily.time as string[]).indexOf(forecastDate);
  if (dateIndex === -1) throw new Error(`Open-Meteo: today (${forecastDate}) not found in response for ${location.code}`);

  // Collect the daily max from each ensemble member for today
  const memberMaxes: number[] = [];
  for (const key of Object.keys(daily)) {
    if (!key.startsWith("temperature_2m_max_member")) continue;
    const val = (daily[key] as number[])[dateIndex];
    if (val != null && !isNaN(val)) memberMaxes.push(val);
  }

  if (memberMaxes.length === 0) {
    throw new Error(`Open-Meteo: no ensemble member values for ${location.code} on ${forecastDate}`);
  }

  const mean = memberMaxes.reduce((a, b) => a + b, 0) / memberMaxes.length;
  const variance = memberMaxes.reduce((sum, t) => sum + (t - mean) ** 2, 0) / memberMaxes.length;
  // Use population std dev from the ensemble spread — this is the genuine uncertainty.
  // Clamp to plausible range: ensemble spread is typically 1-5°F for 1-day forecast.
  const stdDev = Math.max(1.5, Math.min(6, Math.sqrt(variance)));

  const distribution: Record<string, number> = {};
  for (let lo = Math.floor(mean) - 20; lo <= Math.floor(mean) + 20; lo += 5) {
    distribution[`${lo}-${lo + 5}`] = bucketProbability(lo, lo + 5, mean, stdDev);
  }

  return {
    location: location.code,
    forecastDate,
    source: "gfs_ensemble_31member",
    expectedHigh: Math.round(mean * 10) / 10,
    stdDev: Math.round(stdDev * 10) / 10,
    distribution,
    raw: { memberCount: memberMaxes.length, memberMaxes },
  };
}

/**
 * Fallback: NWS hourly point forecast.
 *
 * Less accurate than GFS ensemble (single deterministic run, no uncertainty
 * quantification) but always available as a backup.
 */
export async function fetchNwsForecast(
  location: WeatherLocation,
): Promise<WeatherForecast> {
  const url = `https://api.weather.gov/gridpoints/${location.nwsGridpoint}/forecast/hourly`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)",
      Accept: "application/geo+json",
    },
  });

  if (!response.ok) {
    throw new Error(`NWS fetch failed for ${location.code}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const periods = data?.properties?.periods || [];
  if (periods.length === 0) throw new Error(`NWS: no forecast periods for ${location.code}`);

  const next24 = periods.slice(0, 24);
  const temps = next24.map((p: any) => p.temperature).filter((t: any) => typeof t === "number");
  if (temps.length === 0) throw new Error(`NWS: no numeric temperatures for ${location.code}`);

  const max = Math.max(...temps);
  const variance = temps.reduce((sum: number, t: number) => sum + (t - max) ** 2, 0) / temps.length;
  const stdDev = Math.max(2, Math.min(8, Math.sqrt(variance) / 2));

  const forecastDate = new Date().toLocaleDateString("en-CA", { timeZone: location.timezone });
  const distribution: Record<string, number> = {};
  for (let lo = Math.floor(max) - 15; lo <= Math.floor(max) + 15; lo += 5) {
    distribution[`${lo}-${lo + 5}`] = bucketProbability(lo, lo + 5, max, stdDev);
  }

  return {
    location: location.code,
    forecastDate,
    source: "nws_hourly",
    expectedHigh: max,
    stdDev,
    distribution,
  };
}

/**
 * Main entry point: tries GFS ensemble first, falls back to NWS hourly.
 * Callers should always use this rather than calling the individual fetchers.
 */
export async function fetchForecast(location: WeatherLocation): Promise<WeatherForecast> {
  try {
    return await fetchGfsEnsembleForecast(location);
  } catch (gfsErr) {
    console.warn(`GFS ensemble failed for ${location.code} (${gfsErr instanceof Error ? gfsErr.message : gfsErr}), falling back to NWS`);
    return await fetchNwsForecast(location);
  }
}
