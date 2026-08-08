import { describe, expect, it } from "vitest";
import {
  dominantRejectReason,
  feeHurdleCentsAt,
  type LegCandidate,
  type LegScreenParams,
  screenLeg,
  screenLegs,
} from "./leg-screen.ts";

/** Production values as of 2026-08-08 (auto-trade/index.ts S-001 block). */
const PARAMS: LegScreenParams = {
  minAskCents: 5,
  maxAskCents: 92,
  maxEntryPriceCents: 80,
  feeRate: 0.07,
  minNetEdgePerLegCents: 8,
};

/** A leg that passes every gate, so each test varies exactly one thing. */
function leg(overrides: Partial<LegCandidate> = {}): LegCandidate {
  return { yesAskCents: 40, isOpenTicker: false, perLegEdgeCents: 20, ...overrides };
}

describe("feeHurdleCentsAt", () => {
  it("scales with the payout ratio, so cheap legs must clear far more edge", () => {
    // Buying NO at 50c wins 50c, and 7% of that is 3.5c — 7 edge-cents on a
    // 50c stake. At 20c the stake wins 80c, so the same 7% is 28 edge-cents.
    expect(feeHurdleCentsAt(50, 0.07)).toBeCloseTo(7, 6);
    expect(feeHurdleCentsAt(20, 0.07)).toBeCloseTo(28, 6);
  });

  it("is unreachable at a zero or negative price rather than dividing by zero", () => {
    expect(feeHurdleCentsAt(0, 0.07)).toBe(Infinity);
    expect(feeHurdleCentsAt(-5, 0.07)).toBe(Infinity);
  });
});

describe("screenLeg", () => {
  it("passes a leg inside the band, under the cap, unheld, and above the hurdle", () => {
    expect(screenLeg(leg(), PARAMS)).toBeNull();
  });

  it("rejects a leg outside the ask price band", () => {
    expect(screenLeg(leg({ yesAskCents: 4 }), PARAMS)).toBe("price_band");
    expect(screenLeg(leg({ yesAskCents: 93 }), PARAMS)).toBe("price_band");
  });

  it("admits the inclusive edges of the band", () => {
    // 5c ask => NO at 95c, which the entry cap must then catch; 92c ask => NO
    // at 8c, comfortably under the cap. Neither should read as price_band.
    expect(screenLeg(leg({ yesAskCents: 5 }), PARAMS)).not.toBe("price_band");
    expect(screenLeg(leg({ yesAskCents: 92 }), PARAMS)).not.toBe("price_band");
  });

  it("rejects a NO entry above the 80c cap — the band that carried the live losses", () => {
    // A 19c YES ask is a 81c NO entry: inside the price band, over the cap.
    expect(screenLeg(leg({ yesAskCents: 19 }), PARAMS)).toBe("entry_price_cap");
  });

  it("admits a NO entry exactly at the cap", () => {
    expect(screenLeg(leg({ yesAskCents: 20 }), PARAMS)).toBeNull();
  });

  it("rejects a ticker the account already holds", () => {
    expect(screenLeg(leg({ isOpenTicker: true }), PARAMS)).toBe("already_open");
  });

  it("rejects edge that does not clear the price-scaled fee hurdle", () => {
    // NO at 20c needs 28 edge-cents; 27 is above the 8c absolute floor but
    // still loses money to the fee.
    expect(screenLeg(leg({ yesAskCents: 80, perLegEdgeCents: 27 }), PARAMS))
      .toBe("fee_hurdle");
  });

  it("rejects edge under the absolute floor even when the fee hurdle is lower", () => {
    // NO at 80c has a fee hurdle of just 1.75c, so only the 8c floor bites.
    expect(feeHurdleCentsAt(80, 0.07)).toBeLessThan(8);
    expect(screenLeg(leg({ yesAskCents: 20, perLegEdgeCents: 7 }), PARAMS))
      .toBe("fee_hurdle");
  });

  it("attributes a leg failing several gates to the first one in order", () => {
    // Ask 3c is out of band AND a 97c NO entry AND already held. The band is
    // the coarsest statement, so buckets stay a partition of the candidates.
    expect(screenLeg(leg({ yesAskCents: 3, isOpenTicker: true }), PARAMS))
      .toBe("price_band");
  });
});

describe("screenLegs", () => {
  const candidates = [
    leg({ yesAskCents: 40 }),                    // tradeable
    leg({ yesAskCents: 19 }),                    // entry_price_cap (NO at 81c)
    leg({ yesAskCents: 15 }),                    // entry_price_cap (NO at 85c)
    leg({ yesAskCents: 93 }),                    // price_band
    leg({ yesAskCents: 50, isOpenTicker: true }), // already_open
  ];

  it("returns the survivors and a reject tally that partitions the candidates", () => {
    const { tradeable, summary } = screenLegs(candidates, PARAMS);

    expect(tradeable).toHaveLength(1);
    expect(summary.considered).toBe(5);
    expect(summary.tradeable).toBe(1);
    expect(summary.rejects).toEqual({
      price_band: 1,
      entry_price_cap: 2,
      already_open: 1,
      fee_hurdle: 0,
    });

    const rejected = Object.values(summary.rejects).reduce((a, b) => a + b, 0);
    expect(rejected + summary.tradeable).toBe(summary.considered);
  });

  it("records every NO price the book offered, ascending, including survivors", () => {
    const { summary } = screenLegs(candidates, PARAMS);
    // This is what tells us the market sat above the cap rather than that we
    // simply never looked: 81 and 85 are visible even though both were cut.
    expect(summary.noPricesSeen).toEqual([7, 50, 60, 81, 85]);
  });

  it("reports an empty screen without inventing rejects", () => {
    const { tradeable, summary } = screenLegs([], PARAMS);
    expect(tradeable).toEqual([]);
    expect(summary.considered).toBe(0);
    expect(summary.noPricesSeen).toEqual([]);
    expect(dominantRejectReason(summary)).toBeNull();
  });
});

describe("dominantRejectReason", () => {
  it("names the reason accounting for the most rejects", () => {
    const { summary } = screenLegs(
      [leg({ yesAskCents: 19 }), leg({ yesAskCents: 15 }), leg({ yesAskCents: 93 })],
      PARAMS,
    );
    expect(dominantRejectReason(summary)).toBe("entry_price_cap");
  });

  it("breaks ties toward the earlier reason so the label is stable", () => {
    const { summary } = screenLegs(
      [leg({ yesAskCents: 93 }), leg({ yesAskCents: 19 })],
      PARAMS,
    );
    expect(dominantRejectReason(summary)).toBe("price_band");
  });

  it("returns null when every leg was tradeable", () => {
    const { summary } = screenLegs([leg(), leg({ yesAskCents: 45 })], PARAMS);
    expect(summary.tradeable).toBe(2);
    expect(dominantRejectReason(summary)).toBeNull();
  });
});
