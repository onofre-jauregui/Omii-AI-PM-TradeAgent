/**
 * Shared helpers for the integration test tier.
 *
 * Unlike the unit tests elsewhere in this repo, these hit REAL deployed edge
 * functions over the network (staging/production share one Supabase backend
 * — confirmed by inspecting both kalshitradeagent.live and kalshitradeagent.com's
 * bundled VITE_SUPABASE_URL, both resolve to uyfnezxmgwitpzsrnkst.supabase.co).
 * They authenticate as a dedicated E2E test account (never the real trading
 * account) and only ever place paper-mode trades — never live orders.
 *
 * Requires env vars (not set by default — this tier is excluded from the
 * default `npm test` run, see vitest.config.ts's `exclude` and the separate
 * `npm run test:integration` script):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   E2E_TEST_USER_EMAIL, E2E_TEST_USER_PASSWORD
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — integration tests require it. See helpers.ts's doc comment for the full list.`
    );
  }
  return value;
}

export interface TestSession {
  accessToken: string;
  userId: string;
}

export async function signInTestUser(): Promise<TestSession> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");
  const email = requireEnv("E2E_TEST_USER_EMAIL");
  const password = requireEnv("E2E_TEST_USER_PASSWORD");

  const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Failed to sign in E2E test user: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { accessToken: data.access_token, userId: data.user.id };
}

export function functionUrl(name: string): string {
  return `${requireEnv("SUPABASE_URL")}/functions/v1/${name}`;
}

export async function callFunction(name: string, session: TestSession, body: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(functionUrl(name), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      apikey: requireEnv("SUPABASE_ANON_KEY"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

/** Finds a currently tradeable market via the real kalshi-proxy passthrough
 *  (exercises the endpoint allowlist fixed in this session as a side effect).
 *  Tries a few known-liquid series so the test doesn't depend on one specific
 *  market staying open forever. */
export async function pickTradeableMarket(session: TestSession): Promise<{ ticker: string; yesAskCents: number }> {
  const candidateSeries = ["KXFED", "KXGDP", "KXINX", "KXBTC", "KXETH"];
  const anonKey = requireEnv("SUPABASE_ANON_KEY");

  for (const series of candidateSeries) {
    const url = new URL(functionUrl("kalshi-proxy"));
    url.searchParams.set("endpoint", "markets");
    url.searchParams.set("series_ticker", series);
    url.searchParams.set("status", "open");
    url.searchParams.set("limit", "5");
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${session.accessToken}`, apikey: anonKey },
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const m of data.markets ?? []) {
      const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask ?? 0);
      if (yesAsk >= 0.05 && yesAsk <= 0.95) {
        return { ticker: m.ticker, yesAskCents: Math.round(yesAsk * 100) };
      }
    }
  }
  throw new Error(
    `pickTradeableMarket: no open, priced market found across ${candidateSeries.join(", ")} — ` +
    "Kalshi market conditions may have changed; widen the candidate series list."
  );
}

/** Deletes specific trade rows this test run created, via service-role — keeps
 *  the persistent test account's trade history from growing unbounded across
 *  every CI run. Never deletes by a broad filter, only by explicit ids. */
export async function cleanupTrades(tradeIds: string[]): Promise<void> {
  if (tradeIds.length === 0) return;
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const idList = tradeIds.map(id => `"${id}"`).join(",");
  await fetch(`${supabaseUrl}/rest/v1/trades?id=in.(${idList})`, {
    method: "DELETE",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
}
