import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signInTestUser, functionUrl, cleanupTrades, type TestSession } from "./helpers.ts";

/**
 * Integration coverage for auto-settle — resolves paper trades against real
 * Kalshi outcomes (DESIGN-REPORT.md EF11, HIGH-STAKES, zero orchestration
 * coverage before this file — only its pure computePnl/resolveKalshiMarketAction
 * helpers were unit-tested). Runs against the real deployed function.
 *
 * auto-settle has no per-request auth and processes every unsettled paper
 * trade system-wide in one pass (by design — see its own doc comment, "safe
 * to run repeatedly"). This test doesn't scope it to the test account; it
 * inserts one controlled trade row (service-role, bypassing execute-trade so
 * the price/side/amount are exactly known) against a real, already-finalized
 * Kalshi market, invokes auto-settle, and checks only that specific row.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// A real MVE market, finalized with result "no" as of 2026-07-31 — confirmed
// via a live GET against Kalshi's public /markets/{ticker} endpoint (the same
// one auto-settle itself calls). MVE tickers are excluded from the trading UI
// but are ordinary markets to Kalshi's settlement API, which is all this test
// exercises.
const FINALIZED_TICKER = "KXMVESPORTSMULTIGAMEEXTENDED-S20268FF8C11C546-0FE16F623F4";
const FINALIZED_RESULT = "no";

async function insertControlledTrade(session: TestSession, overrides: Record<string, unknown> = {}): Promise<string> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const payload = {
    user_id: session.userId,
    ticker: FINALIZED_TICKER,
    market_id: FINALIZED_TICKER,
    market_question: "integration test — auto-settle",
    side: "no",
    action: "buy",
    price: 50,
    amount: 10,
    mode: "paper",
    status: "filled",
    filled_price: 50,
    exchange: "paper",
    order_id: `integration-test-${crypto.randomUUID()}`,
    ...overrides,
  };
  const resp = await fetch(`${supabaseUrl}/rest/v1/trades`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to insert controlled trade: HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  const rows = await resp.json();
  return rows[0].id;
}

async function fetchTrade(tradeId: string): Promise<any> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${supabaseUrl}/rest/v1/trades?id=eq.${tradeId}&select=*`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = await resp.json();
  return rows[0];
}

describe("auto-settle (integration)", () => {
  let session: TestSession;
  const createdTradeIds: string[] = [];

  beforeAll(async () => {
    session = await signInTestUser();
  });

  afterAll(async () => {
    await cleanupTrades(createdTradeIds);
  });

  it("is callable and returns a well-formed response (smoke test)", async () => {
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const resp = await fetch(functionUrl("auto-settle"), {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    // Don't over-specify the shape — just prove it ran and returned structured
    // JSON, not a 500/schema error (the exact failure mode found in execute-basket
    // this session).
    expect(json).toBeTypeOf("object");
  });

  it("settles a controlled trade with the correct WIN pnl against a real finalized market", async () => {
    const tradeId = await insertControlledTrade(session);
    createdTradeIds.push(tradeId);

    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const resp = await fetch(functionUrl("auto-settle"), {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(200);

    const settled = await fetchTrade(tradeId);
    expect(settled.status).toBe("settled");
    expect(settled.resolution).toBe(FINALIZED_RESULT);
    // side=no, result=no (correct side), price=50c, amount=$10 →
    // contracts = 10/0.5 = 20, pnl = 20 * (1-0.5) = 10
    expect(Number(settled.pnl)).toBeCloseTo(10, 1);
    expect(settled.net_pnl).not.toBeNull();
    expect(Number(settled.net_pnl)).toBeCloseTo(10, 1);
    expect(settled.settled_at).toBeTruthy();
  });

  it("settles a controlled trade with the correct LOSS pnl on the wrong side", async () => {
    const tradeId = await insertControlledTrade(session, { side: "yes" }); // result is "no" — wrong side
    createdTradeIds.push(tradeId);

    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    await fetch(functionUrl("auto-settle"), {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
      body: "{}",
    });

    const settled = await fetchTrade(tradeId);
    expect(settled.status).toBe("settled");
    // side=yes, result=no (wrong side), price=50c, amount=$10 →
    // contracts = 20, pnl = -20 * 0.5 = -10
    expect(Number(settled.pnl)).toBeCloseTo(-10, 1);
    expect(settled.net_pnl).not.toBeNull();
  });

  it("is idempotent — re-running auto-settle does not re-settle an already-settled trade or change its pnl", async () => {
    const tradeId = await insertControlledTrade(session);
    createdTradeIds.push(tradeId);

    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const call = () => fetch(functionUrl("auto-settle"), {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
      body: "{}",
    });

    await call();
    const firstSettle = await fetchTrade(tradeId);
    expect(firstSettle.status).toBe("settled");

    await call();
    const secondSettle = await fetchTrade(tradeId);
    expect(secondSettle.pnl).toEqual(firstSettle.pnl);
    expect(secondSettle.settled_at).toEqual(firstSettle.settled_at); // untouched on the second pass
  });
});
