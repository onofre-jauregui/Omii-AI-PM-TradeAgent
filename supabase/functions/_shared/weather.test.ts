import { describe, it, expect } from "vitest";
import {
  normalCdf,
  bucketProbability,
  computeBucketProbabilities,
  computeEdge,
  WEATHER_LOCATIONS,
  type WeatherForecast,
  type KalshiWeatherMarket,
} from "./weather";

describe("normalCdf", () => {
  it("returns 0.5 at the mean", () => {
    expect(normalCdf(70, 70, 5)).toBeCloseTo(0.5, 4);
  });

  it("returns ~0.84 at +1 std dev", () => {
    expect(normalCdf(75, 70, 5)).toBeCloseTo(0.8413, 3);
  });

  it("returns ~0.16 at -1 std dev", () => {
    expect(normalCdf(65, 70, 5)).toBeCloseTo(0.1587, 3);
  });

  it("approaches 1 in the right tail", () => {
    expect(normalCdf(90, 70, 5)).toBeGreaterThan(0.999);
  });

  it("approaches 0 in the left tail", () => {
    expect(normalCdf(50, 70, 5)).toBeLessThan(0.001);
  });
});

describe("bucketProbability", () => {
  it("computes probability of a 5-degree bucket centered on the mean", () => {
    // Bucket 67-72, mean 70, sd 5: should be roughly the middle ~38%
    const p = bucketProbability(67, 72, 70, 5);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.5);
  });

  it("returns near-zero for buckets far from the mean", () => {
    const p = bucketProbability(95, 100, 70, 5);
    expect(p).toBeLessThan(0.001);
  });

  it("returns 1 for the full real line", () => {
    const p = bucketProbability(-1000, 1000, 70, 5);
    expect(p).toBeCloseTo(1, 4);
  });

  it("clamps to 0 for empty buckets", () => {
    // High < low — degenerate
    const p = bucketProbability(80, 70, 70, 5);
    expect(p).toBe(0);
  });
});

describe("computeBucketProbabilities", () => {
  const forecast: WeatherForecast = {
    location: "NYC",
    forecastDate: "2026-04-14",
    source: "test",
    expectedHigh: 70,
    stdDev: 5,
    distribution: {},
  };

  it("returns one probability per market", () => {
    const markets: KalshiWeatherMarket[] = [
      { ticker: "T1", bucket_low: 65, bucket_high: 70 },
      { ticker: "T2", bucket_low: 70, bucket_high: 75 },
      { ticker: "T3", bucket_low: 75, bucket_high: 80 },
    ];
    const probs = computeBucketProbabilities(forecast, markets);
    expect(probs.size).toBe(3);
    for (const ticker of ["T1", "T2", "T3"]) {
      expect(probs.has(ticker)).toBe(true);
      const p = probs.get(ticker)!;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("buckets sum to roughly 1 when they cover the full range", () => {
    // Cover 50 to 90 in 5-degree buckets (8 buckets)
    const markets: KalshiWeatherMarket[] = [];
    for (let lo = 50; lo < 90; lo += 5) {
      markets.push({ ticker: `T_${lo}`, bucket_low: lo, bucket_high: lo + 5 });
    }
    const probs = computeBucketProbabilities(forecast, markets);
    const total = Array.from(probs.values()).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0.99);
    expect(total).toBeLessThan(1.01);
  });
});

describe("computeEdge", () => {
  const market = (yesBid: number, yesAsk: number, lo = 65, hi = 75): KalshiWeatherMarket => ({
    ticker: "T_TEST",
    bucket_low: lo,
    bucket_high: hi,
    yes_bid: yesBid,
    yes_ask: yesAsk,
  });

  it("recommends buy_yes when model probability is much higher than ask", () => {
    // Market trades at 30c ask, model says 60% chance
    const e = computeEdge(market(28, 30), 0.6);
    expect(e.direction).toBe("buy_yes");
    expect(e.edgeCents).toBeGreaterThan(20);
  });

  it("recommends buy_no when model probability is much lower than bid", () => {
    // Market trades at 70c bid, model says 30% chance
    const e = computeEdge(market(70, 72), 0.3);
    expect(e.direction).toBe("buy_no");
    expect(e.edgeCents).toBeGreaterThan(20);
  });

  it("skips when model agrees with the market", () => {
    // Model says 50%, market trades 49/51
    const e = computeEdge(market(49, 51), 0.5);
    expect(e.direction).toBe("skip");
  });

  it("skips when there are no quotes", () => {
    const e = computeEdge(
      { ticker: "T", bucket_low: 65, bucket_high: 75, yes_bid: null, yes_ask: null },
      0.5
    );
    expect(e.direction).toBe("skip");
  });

  it("computes implied probability from mid price", () => {
    const e = computeEdge(market(40, 50), 0.5);
    expect(e.impliedProb).toBeCloseTo(0.45, 3);
  });
});

describe("WEATHER_LOCATIONS configuration", () => {
  it("has all four Kalshi cities", () => {
    expect(WEATHER_LOCATIONS).toHaveLength(4);
    const codes = WEATHER_LOCATIONS.map(l => l.code).sort();
    expect(codes).toEqual(["AUS", "CHI", "MIA", "NYC"]);
  });

  it("each location has a non-empty NWS gridpoint", () => {
    for (const loc of WEATHER_LOCATIONS) {
      expect(loc.nwsGridpoint).toMatch(/^[A-Z]+\/\d+,\d+$/);
    }
  });

  it("each location has a climate station identifier", () => {
    for (const loc of WEATHER_LOCATIONS) {
      expect(loc.climateStation).toMatch(/^K[A-Z]{3}$/);
    }
  });
});
