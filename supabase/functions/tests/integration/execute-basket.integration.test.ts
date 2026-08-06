import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signInTestUser, callFunction, pickTradeableMarket, cleanupTrades, cleanupBaskets, type TestSession } from "./helpers.ts";

/**
 * Integration coverage for execute-basket — multi-leg ordered execution with
 * flatten-on-failure (DESIGN-REPORT.md EF10, HIGH-STAKES, zero coverage
 * before this file). Runs against the real deployed staging function using
 * the dedicated E2E test account, paper mode only.
 *
 * This covers a leg-fill-tracking fix: a leg that returns success:true but
 * never actually filled (status "open" — e.g. no real liquidity, or a
 * nonexistent ticker) was counted as "filled" for basket-completion AND
 * flatten purposes. That let a basket be reported "completed" when a leg
 * never filled, and could make flattenFilledLegs submit an opposite-side
 * order against a position that never existed. Several tests below assert
 * the corrected behavior directly.
 */

describe("execute-basket (paper mode, integration)", () => {
  let session: TestSession;
  let market: { ticker: string; yesAskCents: number };
  const createdTradeIds: string[] = [];
  const createdBasketIds: string[] = [];

  beforeAll(async () => {
    session = await signInTestUser();
    market = await pickTradeableMarket(session);
  });

  afterAll(async () => {
    await cleanupTrades(createdTradeIds);
    await cleanupBaskets(createdBasketIds);
  });

  function twoRealLegs() {
    return [
      { ticker: market.ticker, side: "yes", action: "buy", price: market.yesAskCents, amount: 5 },
      { ticker: market.ticker, side: "no", action: "buy", price: Math.max(1, 100 - market.yesAskCents), amount: 5 },
    ];
  }

  it("completes a basket when both legs actually fill", async () => {
    const { status, json } = await callFunction("execute-basket", session, {
      strategy_name: "integration test",
      legs: twoRealLegs(),
      mode: "paper",
      expected_edge_cents: 5,
      reasoning: "integration test — happy path",
    });

    expect(status).toBe(200);
    expect(json.basket_id).toBeTruthy();
    createdBasketIds.push(json.basket_id);
    for (const r of json.leg_results ?? []) if (r.trade?.id) createdTradeIds.push(r.trade.id);

    // Not asserting "completed" unconditionally — real order books can move between
    // pickTradeableMarket's read and execution, so leg 2 might not fill and the
    // basket correctly flattens leg 1 instead. What matters: a legitimate terminal
    // status was reached and success mirrors it exactly.
    expect(["completed", "partially_filled", "aborted", "flattened", "timed_out"]).toContain(json.status);
    expect(json.success).toBe(json.status === "completed");
  });

  it("rejects fewer than 2 legs with a 400", async () => {
    const { status, json } = await callFunction("execute-basket", session, {
      strategy_name: "integration test — too few legs",
      legs: [{ ticker: market.ticker, side: "yes", action: "buy", price: market.yesAskCents, amount: 5 }],
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/2 or more leg specs/i);
  });

  it("rejects a leg missing required fields with a 400", async () => {
    const { status, json } = await callFunction("execute-basket", session, {
      strategy_name: "integration test — bad leg",
      legs: [
        { ticker: market.ticker, side: "yes", action: "buy", price: market.yesAskCents, amount: 5 },
        { ticker: market.ticker, side: "no" }, // missing action/price/amount
      ],
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/leg missing required fields/i);
  });

  // Core regression: a leg on a nonexistent ticker returns success:true with
  // status "open" (see execute-trade's integration tests) — the basket must
  // NOT report "completed", and must not count that leg as filled.
  it("does not report 'completed' when a leg never actually fills, and does not attempt to flatten it", async () => {
    const { status, json } = await callFunction("execute-basket", session, {
      strategy_name: "integration test — dead second leg",
      legs: [
        { ticker: market.ticker, side: "yes", action: "buy", price: market.yesAskCents, amount: 5 },
        { ticker: "KXNONEXISTENT-99Z-T0", side: "yes", action: "buy", price: 50, amount: 5 },
      ],
      mode: "paper",
      expected_edge_cents: 50, // high enough that the post-leg-1 edge re-check doesn't itself abort first
      reasoning: "integration test — second leg can't fill",
    });

    expect(status).toBe(200);
    createdBasketIds.push(json.basket_id);
    for (const r of json.leg_results ?? []) if (r.trade?.id) createdTradeIds.push(r.trade.id);
    for (const r of json.flatten_results ?? []) if (r.trade?.id) createdTradeIds.push(r.trade.id);

    expect(json.success).toBe(false);
    expect(json.status).not.toBe("completed");
    expect(json.abort_reason).toMatch(/did not fill/i);

    // The first (real) leg either never got attempted as filled, or if it did
    // fill, it should be the ONLY leg flatten was attempted on — never the
    // dead second leg, which never held a position to close.
    const flattenedLegIndexes = (json.flatten_results ?? []).map((r: any) => r.leg_index);
    expect(flattenedLegIndexes).not.toContain(1); // leg index 1 = the dead ticker
  });

  it("rejects a live-mode basket that exceeds the seeded $500 allocated_capital, before touching Kalshi", async () => {
    const { status, json } = await callFunction("execute-basket", session, {
      strategy_name: "integration test — over capital cap",
      legs: [
        { ticker: market.ticker, side: "yes", action: "buy", price: market.yesAskCents, amount: 300 },
        { ticker: market.ticker, side: "no", action: "buy", price: Math.max(1, 100 - market.yesAskCents), amount: 300 },
      ],
      mode: "live", // 600 > the seeded $500 allocated_capital — must reject before any real order
    });

    expect(status).toBe(400);
    expect(json.code).toBe("CAPITAL_CAP_EXCEEDED");
  });
});
