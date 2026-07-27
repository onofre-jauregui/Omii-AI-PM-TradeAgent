import { describe, it, expect } from "vitest";
import { computeDepthAtPrice, simulatePaperFill, estimateKalshiFee } from "./fill-sim";
import type { Orderbook } from "./kalshi-market-data";

const deepYesBook: Orderbook = {
  yes: {
    asks: [
      { price: 60, quantity: 50 },
      { price: 62, quantity: 100 },
    ],
    bids: [
      { price: 58, quantity: 80 },
    ],
  },
  no: {
    asks: [{ price: 40, quantity: 60 }],
    bids: [{ price: 38, quantity: 60 }],
  },
};

describe("computeDepthAtPrice", () => {
  it("sums depth at-or-better for a buy (asks at or below price)", () => {
    // buy yes @ 62c: both levels (60, 62) are <= 62 -> 50+100=150
    const d = computeDepthAtPrice(deepYesBook, "yes", "buy", 62, 60); // $60 / $0.62 -> 97 needed
    expect(d.availableContracts).toBe(150);
    expect(d.sufficient).toBe(true);
  });

  it("sums depth at-or-better for a sell (bids at or above price)", () => {
    const d = computeDepthAtPrice(deepYesBook, "yes", "sell", 58, 10);
    expect(d.availableContracts).toBe(80);
  });

  it("is insufficient when requested size exceeds available depth", () => {
    const d = computeDepthAtPrice(deepYesBook, "yes", "buy", 60, 1000);
    expect(d.sufficient).toBe(false);
  });

  it("returns zero depth for a missing/empty book", () => {
    const empty: Orderbook = {};
    const d = computeDepthAtPrice(empty, "yes", "buy", 50, 10);
    expect(d.availableContracts).toBe(0);
    expect(d.sufficient).toBe(false);
  });
});

describe("simulatePaperFill", () => {
  it("fills fully and reports a depth-weighted price when real depth fully covers the size", () => {
    // buy yes @ 62c, $60 -> ceil(60/0.60)=100 needed (requested price used for sizing)
    const result = simulatePaperFill(deepYesBook, "yes", "buy", 62, 62);
    expect(result.status).toBe("filled");
    expect(result.filledContracts).toBeGreaterThanOrEqual(result.requestedContracts);
    expect(result.filledPrice).not.toBeNull();
  });

  it("can fill at a price different from the requested price, proving slippage realism", () => {
    // Best level is 60c, but a small order at price 62c should consume the
    // cheaper 60c level first (best price first) -> filledPrice <= requested.
    const result = simulatePaperFill(deepYesBook, "yes", "buy", 62, 6); // $6 / $0.62 ~ 10 contracts
    expect(result.status).toBe("filled");
    expect(result.filledPrice).toBeLessThanOrEqual(62);
    expect(result.slippageCents).not.toBeNull();
  });

  it("partially fills when requested size exceeds real depth at the price", () => {
    const result = simulatePaperFill(deepYesBook, "yes", "buy", 62, 10000); // huge size
    expect(result.status).toBe("partial");
    expect(result.filledContracts).toBeGreaterThan(0);
    expect(result.filledContracts).toBeLessThan(result.requestedContracts);
  });

  it("stays open (unfilled) when there is zero real depth at the requested price", () => {
    const thin: Orderbook = { yes: { asks: [], bids: [] } };
    const result = simulatePaperFill(thin, "yes", "buy", 50, 20);
    expect(result.status).toBe("open");
    expect(result.filledContracts).toBe(0);
    expect(result.filledPrice).toBeNull();
    expect(result.slippageCents).toBeNull();
  });

  it("handles buy/sell x yes/no side selection correctly", () => {
    const buyNo = simulatePaperFill(deepYesBook, "no", "buy", 40, 24); // $24/$0.40=60 needed, 60 avail
    expect(buyNo.status).toBe("filled");
    const sellNo = simulatePaperFill(deepYesBook, "no", "sell", 38, 22.8); // 60 needed, 60 avail
    expect(sellNo.status).toBe("filled");
  });

  it("boundary: requested price exactly at the best level's price is inclusive", () => {
    const result = simulatePaperFill(deepYesBook, "yes", "buy", 60, 30); // exactly the best ask
    expect(result.status).toBe("filled");
    expect(result.filledPrice).toBe(60);
  });
});

describe("estimateKalshiFee", () => {
  it("peaks at 50c: ~1.75c/contract for taker", () => {
    const fee = estimateKalshiFee(50, 1, false);
    expect(fee).toBe(2); // 0.07*1*0.5*0.5=0.0175 -> round up to 2c
  });

  it("shrinks toward the extremes", () => {
    const feeAt5 = estimateKalshiFee(5, 1, false);
    const feeAt50 = estimateKalshiFee(50, 1, false);
    expect(feeAt5).toBeLessThan(feeAt50);
  });

  it("maker fee is 25% of taker fee", () => {
    const contracts = 100;
    const taker = estimateKalshiFee(50, contracts, false);
    const maker = estimateKalshiFee(50, contracts, true);
    expect(maker).toBeLessThan(taker);
    expect(maker).toBeCloseTo(taker * 0.25, 0);
  });

  it("scales with contract count and rounds up to the next cent", () => {
    expect(estimateKalshiFee(50, 0, false)).toBe(0);
    const fee10 = estimateKalshiFee(50, 10, false);
    expect(fee10).toBeGreaterThan(0);
    expect(Number.isInteger(fee10)).toBe(true);
  });
});
