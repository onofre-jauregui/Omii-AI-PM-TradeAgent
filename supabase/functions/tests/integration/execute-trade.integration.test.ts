import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signInTestUser, callFunction, functionUrl, pickTradeableMarket, cleanupTrades, type TestSession } from "./helpers.ts";

/**
 * Integration coverage for execute-trade — the sole real order-placement
 * path in the app (DESIGN-REPORT.md EF9, HIGH-STAKES, zero coverage before
 * this file). Runs against the real deployed staging function using the
 * dedicated E2E test account, paper mode only — never places a live order.
 *
 * The test account's paper risk_settings (seeded during Phase 0
 * provisioning) has max_position_size=20, so $10 is comfortably under the
 * limit and $25 is comfortably over it — both tests below rely on that
 * seeded value, not a magic number.
 */

describe("execute-trade (paper mode, integration)", () => {
  let session: TestSession;
  let market: { ticker: string; yesAskCents: number };
  const createdTradeIds: string[] = [];

  beforeAll(async () => {
    session = await signInTestUser();
    market = await pickTradeableMarket(session);
  });

  afterAll(async () => {
    await cleanupTrades(createdTradeIds);
  });

  it("places a paper trade within risk limits and returns a real trade row", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      marketQuestion: "integration test",
      side: "yes",
      action: "buy",
      price: market.yesAskCents,
      amount: 10, // well under the seeded $20 max_position_size
      mode: "paper",
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.trade).toBeTruthy();
    expect(json.trade.mode).toBe("paper");
    expect(json.trade.ticker).toBe(market.ticker);
    expect(["filled", "open", "partial"]).toContain(json.trade.status);

    if (json.trade?.id) createdTradeIds.push(json.trade.id);
  });

  it("rejects a paper trade that exceeds the seeded max_position_size risk limit", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      marketQuestion: "integration test — oversized",
      side: "yes",
      action: "buy",
      price: market.yesAskCents,
      amount: 25, // over the seeded $20 max_position_size
      mode: "paper",
    });

    // execute-trade returns 200 even on a risk rejection — the failure is in the body.
    expect(status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.error).toBeTruthy();
    expect(json.trade?.status).toBe("failed");

    if (json.trade?.id) createdTradeIds.push(json.trade.id);
  });

  // Kalshi's orderbook endpoint does NOT 404 for a nonexistent ticker — it
  // returns 200 with a fully empty book (verified directly against the live
  // API, 2026-07-31). So execute-trade's "dead ticker" hard-fail path (which
  // only triggers on a non-2xx response) never fires for this case; the trade
  // instead resolves through the normal fill-simulation path with zero
  // available depth, producing an unfilled resting "open" order rather than
  // a rejection. That's a real, separate, lower-severity gap from the
  // orderbook-parsing bug fixed in kalshi-market-data.ts this session — a
  // typo'd/nonexistent ticker creates a phantom paper position that can
  // never settle, rather than being rejected outright — flagged in
  // DESIGN-REPORT.md §6 rather than silently fixed here, since the fix
  // (treating an empty book as "not tradeable") would also reject legitimate
  // trades on a real but currently thin/new market with zero resting orders,
  // which is a real product tradeoff, not an obvious bug fix.
  it("creates an unfilled 'open' paper position on a nonexistent ticker (documents current behavior, not intended behavior — see DESIGN-REPORT.md §6)", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: "KXNONEXISTENT-99Z-T0",
      marketQuestion: "integration test — dead ticker",
      side: "yes",
      action: "buy",
      price: 50,
      amount: 5,
      mode: "paper",
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.trade?.status).toBe("open");
    expect(json.trade?.filled_price).toBeNull();

    if (json.trade?.id) createdTradeIds.push(json.trade.id);
  });

  it("rejects a request missing required fields with a 400", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "yes",
      // action, price, amount omitted
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/missing required fields/i);
  });

  it("rejects an invalid side value with a 400", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "maybe",
      action: "buy",
      price: market.yesAskCents,
      amount: 5,
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/invalid side/i);
  });

  it("rejects an invalid action value with a 400", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "yes",
      action: "short", // not "buy"/"sell"
      price: market.yesAskCents,
      amount: 5,
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/invalid side/i); // same combined validation message
  });

  it("rejects a price above 99 cents with a 400", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "yes",
      action: "buy",
      price: 100,
      amount: 5,
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/price must be between/i);
  });

  it("rejects a price of 0 (falls the required-field check, price is falsy)", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "yes",
      action: "buy",
      price: 0,
      amount: 5,
      mode: "paper",
    });

    expect(status).toBe(400);
    expect(json.error).toMatch(/missing required fields/i);
  });

  it("rejects a request with no Authorization header at all", async () => {
    const resp = await fetch(functionUrl("execute-trade"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: market.ticker, side: "yes", action: "buy",
        price: market.yesAskCents, amount: 5, mode: "paper",
      }),
    });
    expect(resp.status).toBe(401);
  });

  // execute-trade's amount validation is a truthiness check (`!amount`), which
  // a negative number passes — it's never range-checked as > 0 anywhere in the
  // function. Documents current behavior rather than asserting an unverified
  // "should reject" — worth a decision from Onofre on whether this needs a
  // hard >0 check, since a negative amount reaching the risk/capital-cap math
  // downstream is untested territory this alone doesn't prove is exploitable,
  // just that the front door doesn't stop it.
  it("does not reject a negative amount at the validation layer (documents a gap, not intended behavior)", async () => {
    const { status, json } = await callFunction("execute-trade", session, {
      ticker: market.ticker,
      side: "yes",
      action: "buy",
      price: market.yesAskCents,
      amount: -5,
      mode: "paper",
    });

    // Not asserting success/failure here — only that validation doesn't 400 it,
    // which is itself the finding worth a human decision, not a fix baked into
    // a test assertion.
    expect(status).toBe(200);
    if (json.trade?.id) createdTradeIds.push(json.trade.id);
  });
});
