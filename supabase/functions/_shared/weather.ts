/**
 * Weather forecasting math for the S-005 weather strategy.
 *
 * Pure functions here — no I/O except the explicit fetchNwsForecast helper,
 * which is the only function that touches the network. Everything else is
 * deterministic and unit-testable.
 *
 * Strategy backing:
 *  - Kalshi weather markets settle on the NWS Daily Climate Report
 *    [verified — Kalshi Help Center]
 *  - NWS publishes hourly forecasts at api.weather.gov with no auth
 *    [verified — api.weather.gov docs]
 *  - GFS ensemble data (31 members) is more accurate but requires NOAA
 *    NOMADS access and is more involved to parse. This module ships with
 *    a simpler NWS hourly fallback first, with a hook for upgrading to
 *    GFS ensemble in a follow-up.
 */

// ─── Locations Kalshi runs daily weather markets for ─────────────────────

export interface WeatherLocation {
  code: string;
  name: string;
  // NWS gridpoint endpoint for hourly forecast. Format: WFO/X,Y/forecast/hourly
  // Coordinates are the airport / climate station that NWS Daily Climate
  // Report uses for the city. Verified against api.weather.gov.
  nwsGridpoint: string;
  // Climate station identifier used by Kalshi for settlement (informational)
  climateStation: string;
}

export const WEATHER_LOCATIONS: WeatherLocation[] = [
  {
    code: "NYC",
    name: "New York City",
    nwsGridpoint: "OKX/33,37",
    climateStation: "KNYC",
  },
  {
    code: "CHI",
    name: "Chicago",
    nwsGridpoint: "LOT/76,73",
    climateStation: "KORD",
  },
  {
    code: "MIA",
    name: "Miami",
    nwsGridpoint: "MFL/110,50",
    climateStation: "KMIA",
  },
  {
    code: "AUS",
    name: "Austin",
    nwsGridpoint: "EWX/156,91",
    climateStation: "KAUS",
  },
];

// ─── Forecast data shape ─────────────────────────────────────────────────

export interface WeatherForecast {
  location: string;
  forecastDate: string; // ISO date for the day the high temp will occur
  source: string;
  /** Mean of the temperature distribution (degrees F) */
  expectedHigh: number;
  /** Standard deviation of the distribution (degrees F) */
  stdDev: number;
  /**
   * Bucketed probability distribution: { "55-59": 0.10, "60-64": 0.35, ... }
   * Buckets are emitted in 5-degree spans. The caller can re-bucket if Kalshi
   * uses different bucket boundaries.
   */
  distribution: Record<string, number>;
  raw?: any;
}

// ─── Pure math: normal CDF and PDF ───────────────────────────────────────
// We model the daily high temperature as approximately normal around the
// forecast mean. The std dev is estimated from the spread of the hourly
// forecast values when GFS ensemble isn't available.

/** Standard normal CDF using the Abramowitz & Stegun approximation. */
export function normalCdf(x: number, mean = 0, stdDev = 1): number {
  if (stdDev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stdDev * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

/** Error function approximation (Abramowitz & Stegun 7.1.26, max error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Probability that the daily high falls in [low, high] given a normal
 * forecast distribution with the given mean and std dev.
 */
export function bucketProbability(
  low: number,
  high: number,
  mean: number,
  stdDev: number
): number {
  const pHigh = normalCdf(high, mean, stdDev);
  const pLow = normalCdf(low, mean, stdDev);
  return Math.max(0, Math.min(1, pHigh - pLow));
}

// ─── Bucket probability computation for a set of Kalshi markets ───────────

export interface KalshiWeatherMarket {
  ticker: string;
  bucket_low: number;
  bucket_high: number;
  yes_bid?: number | null;
  yes_ask?: number | null;
  market_question?: string | null;
}

/**
 * For each Kalshi weather market, compute the model's probability that the
 * day's high lands in that bucket. Returns a map ticker -> probability.
 */
export function computeBucketProbabilities(
  forecast: WeatherForecast,
  markets: KalshiWeatherMarket[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of markets) {
    const p = bucketProbability(
      m.bucket_low,
      m.bucket_high,
      forecast.expectedHigh,
      forecast.stdDev
    );
    out.set(m.ticker, p);
  }
  return out;
}

// ─── Edge calculation vs market price ─────────────────────────────────────

export interface EdgeResult {
  /** "buy_yes" if model says market is underpriced YES, "buy_no" if overpriced */
  direction: "buy_yes" | "buy_no" | "skip";
  /** True probability per the model (0..1) */
  trueProb: number;
  /** Implied probability from the current Kalshi price (0..1) */
  impliedProb: number;
  /** Edge in cents per contract (positive = profitable in the chosen direction) */
  edgeCents: number;
}

/**
 * Compare model probability to Kalshi market price and return a buy decision.
 *
 * Convention: prices are in cents (1-99). Implied probability = price/100.
 *
 * If the model probability is meaningfully higher than the YES ask, buy YES.
 * If meaningfully lower than the YES bid, buy NO at (100 - bid).
 * Otherwise skip.
 */
export function computeEdge(
  market: KalshiWeatherMarket,
  trueProb: number
): EdgeResult {
  const yesAsk = market.yes_ask;
  const yesBid = market.yes_bid;

  if (yesAsk == null && yesBid == null) {
    return { direction: "skip", trueProb, impliedProb: NaN, edgeCents: 0 };
  }

  // Use mid-price as the implied probability for the comparison
  const mid = yesAsk != null && yesBid != null
    ? (yesAsk + yesBid) / 2
    : yesAsk ?? yesBid ?? 50;
  const impliedProb = mid / 100;

  const trueProbCents = trueProb * 100;

  // Buy YES at yes_ask: pay yes_ask, expected payoff = trueProb * 100 cents
  // Edge = trueProbCents - yes_ask (positive = profitable)
  const buyYesEdge = trueProbCents - (yesAsk ?? mid);

  // Buy NO at (100 - yes_bid): pay (100 - yes_bid), expected payoff = (1 - trueProb) * 100
  // Edge = (100 - trueProbCents) - (100 - yes_bid) = yes_bid - trueProbCents
  // Positive means NO is profitable (market thinks YES probability is higher than truth)
  const buyNoEdge = (yesBid ?? mid) - trueProbCents;

  if (buyYesEdge >= buyNoEdge && buyYesEdge > 0) {
    return { direction: "buy_yes", trueProb, impliedProb, edgeCents: buyYesEdge };
  }
  if (buyNoEdge > 0) {
    return { direction: "buy_no", trueProb, impliedProb, edgeCents: buyNoEdge };
  }
  return { direction: "skip", trueProb, impliedProb, edgeCents: 0 };
}

// ─── NWS forecast fetch (the only impure function in this module) ──────────

/**
 * Fetch the NWS hourly forecast for a location and reduce it to a daily
 * high-temperature distribution.
 *
 * NWS api.weather.gov is unauthenticated and free, but it requires a
 * descriptive User-Agent header per their TOS.
 *
 * IMPORTANT: this function is the ONE non-pure function in this module.
 * Tests should mock it. The production code path uses it.
 */
export async function fetchNwsForecast(
  location: WeatherLocation
): Promise<WeatherForecast> {
  const url = `https://api.weather.gov/gridpoints/${location.nwsGridpoint}/forecast/hourly`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)",
      Accept: "application/geo+json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `NWS fetch failed for ${location.code}: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  const periods = data?.properties?.periods || [];
  if (periods.length === 0) {
    throw new Error(`NWS returned no forecast periods for ${location.code}`);
  }

  // Take temperatures for the next 24 hours and find the max as expected high
  const next24 = periods.slice(0, 24);
  const temps = next24.map((p: any) => p.temperature).filter((t: any) => typeof t === "number");
  if (temps.length === 0) {
    throw new Error(`No numeric temperatures in NWS forecast for ${location.code}`);
  }

  const max = Math.max(...temps);
  // Estimate the std dev from the spread of the hourly values around the max.
  // This is a rough proxy until we wire in GFS ensemble data — typically 2-4°F
  // for short-range forecasts on a clear day, larger when weather is volatile.
  const variance = temps.reduce((sum, t) => sum + (t - max) * (t - max), 0) / temps.length;
  const rawStdDev = Math.sqrt(variance);
  const stdDev = Math.max(2, Math.min(8, rawStdDev / 2)); // clamp to plausible range

  // Build bucketed distribution in 5°F spans from max-15 to max+15
  const distribution: Record<string, number> = {};
  for (let lo = Math.floor(max) - 15; lo <= Math.floor(max) + 15; lo += 5) {
    const hi = lo + 5;
    distribution[`${lo}-${hi}`] = bucketProbability(lo, hi, max, stdDev);
  }

  return {
    location: location.code,
    forecastDate: new Date().toISOString().split("T")[0],
    source: "nws_hourly",
    expectedHigh: max,
    stdDev,
    distribution,
  };
}
