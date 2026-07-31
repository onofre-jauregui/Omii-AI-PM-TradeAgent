import { describe, it, expect } from "vitest";
import { parseKalshiOrderbook } from "./kalshi-market-data.ts";

// Regression lock for a severe finding from the 2026-07-31 integration-test
// pass: fetchOrderbook previously cast Kalshi's raw API response directly to
// the internal `Orderbook` type with no transformation. The real API has no
// top-level `yes`/`no` keys at all — everything lives under
// `orderbook_fp.{yes,no}_dollars` — so `orderbook.yes`/`orderbook.no` were
// always `undefined` for every real request, meaning every paper-trade fill
// simulation and every live pre-trade liquidity check walked an empty book
// regardless of real market depth. This was never caught because
// fill-sim.test.ts's fixtures hand-construct the internal shape directly.
// Fixture below is a real captured response (KXFED-27APR-T4.25, 2026-07-31).

const REAL_CAPTURED_RESPONSE = {
  orderbook_fp: {
    no_dollars: [
      ["0.0100", "232470.00"],
      ["0.0200", "9780.00"],
      ["0.0300", "16483.00"],
      ["0.4600", "0.83"],
      ["0.4700", "127.87"],
      ["0.7200", "91.00"],
    ],
    yes_dollars: [
      ["0.0100", "36.54"],
      ["0.0200", "15.99"],
      ["0.0600", "121.00"],
      ["0.0700", "133.00"],
    ],
  },
};

describe("parseKalshiOrderbook", () => {
  it("does not return undefined yes/no sides for a real captured API response — the core regression", () => {
    const parsed = parseKalshiOrderbook(REAL_CAPTURED_RESPONSE);
    expect(parsed.yes).toBeDefined();
    expect(parsed.no).toBeDefined();
    expect(parsed.yes!.bids!.length).toBeGreaterThan(0);
    expect(parsed.no!.bids!.length).toBeGreaterThan(0);
  });

  it("parses yes_dollars into yes.bids as cents + contract count", () => {
    const parsed = parseKalshiOrderbook(REAL_CAPTURED_RESPONSE);
    expect(parsed.yes!.bids).toContainEqual({ price: 1, quantity: 36.54 });
    expect(parsed.yes!.bids).toContainEqual({ price: 7, quantity: 133 });
  });

  it("parses no_dollars into no.bids as cents + contract count", () => {
    const parsed = parseKalshiOrderbook(REAL_CAPTURED_RESPONSE);
    expect(parsed.no!.bids).toContainEqual({ price: 1, quantity: 232470 });
    expect(parsed.no!.bids).toContainEqual({ price: 46, quantity: 0.83 });
  });

  it("mirrors no bids into yes asks at (100 - price)", () => {
    const parsed = parseKalshiOrderbook(REAL_CAPTURED_RESPONSE);
    // a no bid at 1c means someone will sell yes at 99c
    expect(parsed.yes!.asks).toContainEqual({ price: 99, quantity: 232470 });
    expect(parsed.yes!.asks).toContainEqual({ price: 54, quantity: 0.83 });
  });

  it("mirrors yes bids into no asks at (100 - price)", () => {
    const parsed = parseKalshiOrderbook(REAL_CAPTURED_RESPONSE);
    // a yes bid at 7c means someone will sell no at 93c
    expect(parsed.no!.asks).toContainEqual({ price: 93, quantity: 133 });
  });

  it("returns empty (not undefined) sides for a fully empty book — the dead/illiquid-ticker case", () => {
    const parsed = parseKalshiOrderbook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } });
    expect(parsed.yes!.bids).toEqual([]);
    expect(parsed.yes!.asks).toEqual([]);
    expect(parsed.no!.bids).toEqual([]);
    expect(parsed.no!.asks).toEqual([]);
  });

  it("handles a response missing orderbook_fp entirely without throwing", () => {
    const parsed = parseKalshiOrderbook({});
    expect(parsed.yes!.bids).toEqual([]);
    expect(parsed.no!.bids).toEqual([]);
  });

  it("handles null/undefined input without throwing", () => {
    expect(() => parseKalshiOrderbook(null)).not.toThrow();
    expect(() => parseKalshiOrderbook(undefined)).not.toThrow();
  });
});
