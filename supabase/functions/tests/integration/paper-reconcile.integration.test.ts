import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signInTestUser, functionUrl, pickTradeableMarket, cleanupTrades, type TestSession } from "./helpers.ts";

/**
 * Integration coverage for paper-reconcile — advances resting paper orders
 * by re-simulating against the CURRENT real orderbook (DESIGN-REPORT.md
 * EF14, zero orchestration coverage before this file). This function shares
 * fetchOrderbook/simulatePaperFill with execute-trade, so it directly
 * exercises this session's orderbook-parsing fix (finding #18) as well —
 * before that fix, every trade here would have seen an empty book and never
 * advanced past "open" regardless of real market conditions.
 *
 * No per-request auth (matches auto-settle/reconcile-orders — cron-invoked,
 * processes every resting paper order system-wide). This test inserts
 * controlled trade rows (service-role) rather than scoping by user.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function insertOpenTrade(session: TestSession, ticker: string, price: number, amount = 5): Promise<string> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${supabaseUrl}/rest/v1/trades`, {
    method: "POST",
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json", Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: session.userId,
      ticker, market_id: ticker,
      market_question: "integration test — paper-reconcile",
      side: "yes", action: "buy", price, amount,
      mode: "paper", status: "open",
      exchange: "paper",
      order_id: `integration-test-${crypto.randomUUID()}`,
    }),
  });
  if (!resp.ok) throw new Error(`Failed to insert open trade: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  return (await resp.json())[0].id;
}

async function fetchTrade(tradeId: string): Promise<any> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${supabaseUrl}/rest/v1/trades?id=eq.${tradeId}&select=*`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  return (await resp.json())[0];
}

/** Reads the REAL orderbook directly (not the /markets list's summary price,
 *  which can be a last-traded-price fallback with zero live depth behind it)
 *  and returns { price, amount } sized so cumulative depth at that price
 *  covers the requested contracts from THIS snapshot — or null if there's no
 *  usable depth. Walks a few cents past the single best level and uses a
 *  small $1 order specifically so a thin top-of-book level (single-digit
 *  contracts, observed on real KXFED strikes) disappearing between this
 *  read and paper-reconcile's own re-fetch a moment later doesn't flip the
 *  result — the known tradeoff of asserting against a live, moving book. */
async function findFillablePrice(session: TestSession, ticker: string): Promise<{ price: number; amount: number } | null> {
  const url = new URL(functionUrl("kalshi-proxy"));
  url.searchParams.set("endpoint", `markets/${ticker}/orderbook`);
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${session.accessToken}`, apikey: requireEnv("SUPABASE_ANON_KEY") },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const noLevels: [string, string][] = data?.orderbook_fp?.no_dollars ?? [];
  if (noLevels.length === 0) return null;

  // Mirror to yes-ask levels (100 - no_bid_price) and walk from best (lowest
  // ask) outward, a few cents of margin at a time, until cumulative depth
  // covers at least 2 contracts at a $1 order size.
  const yesAsks = noLevels
    .map(([p, q]) => ({ price: 100 - Math.round(Number(p) * 100), qty: Number(q) }))
    .sort((a, b) => a.price - b.price);

  const amount = 1; // $1 — minimizes contracts needed so thin levels still cover it
  for (const marginCents of [0, 2, 5, 10]) {
    const price = Math.min(99, yesAsks[0].price + marginCents);
    const cumulative = yesAsks.filter(l => l.price <= price).reduce((sum, l) => sum + l.qty, 0);
    const contractsNeeded = Math.ceil(amount / (price / 100));
    if (cumulative >= contractsNeeded) return { price, amount };
  }
  return null;
}

async function callPaperReconcile(): Promise<{ status: number; json: any }> {
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(functionUrl("paper-reconcile"), {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: "{}",
  });
  return { status: resp.status, json: await resp.json() };
}

describe("paper-reconcile (integration)", () => {
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

  it("is callable and returns a well-formed response (smoke test)", async () => {
    const { status, json } = await callPaperReconcile();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json).toHaveProperty("checked");
  });

  // Regression coverage for finding #18: before the orderbook-parsing fix,
  // computeDepthAtPrice always saw undefined levels regardless of real
  // liquidity, so this resting order could never have advanced no matter how
  // aggressive the limit price. Price 99c on a real liquid market should
  // cross virtually any resting ask.
  it("advances a resting order to filled/partial when the requested price now crosses the real book", async () => {
    // A blind 99c limit isn't guaranteed to cross — Kalshi's book only carries
    // resting bids, so a market with no live no_dollars depth (summary price
    // was a last-trade fallback, not live liquidity) has nothing to match
    // against regardless of price. Derive a price from the real orderbook
    // instead of assuming.
    const fillable = await findFillablePrice(session, market.ticker);
    if (fillable === null) {
      console.warn(`No live orderbook depth on ${market.ticker} right now — skipping fill assertion.`);
      return;
    }

    const tradeId = await insertOpenTrade(session, market.ticker, fillable.price, fillable.amount);
    createdTradeIds.push(tradeId);

    const { status } = await callPaperReconcile();
    expect(status).toBe(200);

    const reconciled = await fetchTrade(tradeId);
    expect(["filled", "partial"]).toContain(reconciled.status);
    expect(reconciled.filled_price).not.toBeNull();
  });

  it("leaves a resting order unchanged (still 'open') when the requested price is unrealistic", async () => {
    const tradeId = await insertOpenTrade(session, market.ticker, 1); // 1c buy — essentially never marketable
    createdTradeIds.push(tradeId);

    const { status } = await callPaperReconcile();
    expect(status).toBe(200);

    const reconciled = await fetchTrade(tradeId);
    expect(reconciled.status).toBe("open");
    expect(reconciled.filled_price).toBeNull();
  });

  it("is idempotent — a second run does not re-process an already-filled order", async () => {
    const fillable = await findFillablePrice(session, market.ticker);
    if (fillable === null) {
      console.warn(`No live orderbook depth on ${market.ticker} right now — skipping.`);
      return;
    }
    const tradeId = await insertOpenTrade(session, market.ticker, fillable.price, fillable.amount);
    createdTradeIds.push(tradeId);

    await callPaperReconcile();
    const firstPass = await fetchTrade(tradeId);

    await callPaperReconcile();
    const secondPass = await fetchTrade(tradeId);

    expect(secondPass.status).toBe(firstPass.status);
    expect(secondPass.filled_price).toBe(firstPass.filled_price);
  });
});
