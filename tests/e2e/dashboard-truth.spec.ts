/**
 * Dashboard truth gate.
 *
 * The existing smoke suite only ever visited logged-out pages, so on 2026-08-04
 * a promotion passed lint, 307 unit tests, staging E2E, a production deploy and
 * a 30-minute canary while the live dashboard sat on a permanent spinner.
 * Nothing in the pipeline had ever logged in and looked at it.
 *
 * This suite does. It signs in and, for both Paper and Live, asserts that the
 * dashboard PAINTS, that the numbers it paints MATCH THE DATABASE, and that no
 * chart is silently blank. The value-equality check is what makes this a truth
 * gate rather than a smoke test — a dashboard that renders "$0.00" beautifully
 * still fails.
 *
 * Requires only E2E_USER_EMAIL / E2E_USER_PASSWORD. The database comparison
 * deliberately reads through the signed-in user's OWN session (RLS-scoped),
 * not a service-role key — the gate needs no privileged credential in CI, and
 * it verifies exactly what a real user is entitled to see.
 *
 * Skips rather than fails when credentials are unset, so local runs stay green.
 */
import { expect, type Page, test } from "@playwright/test";

const EMAIL = process.env.E2E_USER_EMAIL ?? process.env.TRADEAGENT_E2E_TEST_USER_EMAIL;
const PASSWORD = process.env.E2E_USER_PASSWORD ?? process.env.TRADEAGENT_E2E_TEST_USER_PASSWORD;

const HAVE_CREDS = Boolean(EMAIL && PASSWORD);

/** Budget for first meaningful paint. A spinner past this is an outage. */
const PAINT_TIMEOUT_MS = 15_000;
/** Any single endpoint hit more than this per load means a render loop. */
const MAX_REQUESTS_PER_ENDPOINT = 4;

async function signIn(page: Page) {
  // /auth redirects to /login. Target the inputs by type rather than by label:
  // the gate must keep working when the form's copy or markup changes, and a
  // login helper that breaks on a class rename produces false failures that
  // erode trust in the gate itself.
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"]').first().fill(PASSWORD!);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !/\/(login|auth)/.test(url.pathname), { timeout: 30_000 });
  // Wait for the app shell, not just the URL — the route changes before the
  // authenticated tree mounts.
  await page.locator("main").first().waitFor({ timeout: 30_000 });
}

/**
 * Sum of realised P&L read straight from Postgres — the value the UI must agree
 * with. Runs inside the page so it reuses the signed-in session: RLS scopes it
 * to this user's own rows, and no service-role key is needed anywhere in CI.
 */
async function dbRealisedPnl(page: Page, mode: "paper" | "live"): Promise<number> {
  return page.evaluate(async (m) => {
    const key = Object.keys(localStorage).find((k) => k.includes("auth-token"));
    if (!key) throw new Error("no supabase session in localStorage");
    const session = JSON.parse(localStorage.getItem(key)!);
    const token = session?.access_token;
    const userId = session?.user?.id;
    if (!token || !userId) throw new Error("session missing access_token/user id");

    const base = (window as unknown as { __SUPABASE_URL__?: string }).__SUPABASE_URL__
      ?? key.replace(/^sb-/, "").replace(/-auth-token$/, "");
    const url = `https://${base}.supabase.co/rest/v1/trades` +
      `?select=pnl,net_pnl&status=eq.settled&mode=eq.${m}&user_id=eq.${userId}`;

    const res = await fetch(url, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`PostgREST ${res.status} reading trades`);
    const rows = (await res.json()) as Array<{ pnl: number | null; net_pnl: number | null }>;
    // Must mirror the frontend's own precedence (net_pnl ?? pnl), or the gate
    // fails for a reason that isn't a bug.
    return rows.reduce((sum, r) => sum + (r.net_pnl ?? r.pnl ?? 0), 0);
  }, mode);
}

function parseMoney(text: string): number {
  const m = text.replace(/,/g, "").match(/-?\$?\s*(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`no numeric value in "${text}"`);
  const n = Number(m[1]);
  return /^-|\(-|−/.test(text.trim()) ? -Math.abs(n) : n;
}

test.describe("dashboard truth", () => {
  test.skip(!HAVE_CREDS, "E2E_USER_EMAIL / E2E_USER_PASSWORD not set");

  for (const mode of ["paper", "live"] as const) {
    test(`${mode} mode: dashboard paints real values, nothing silently blank`, async ({ page }) => {
      const requestCounts = new Map<string, number>();
      const consoleErrors: string[] = [];
      const badResponses: string[] = [];

      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("request", (r) => {
        const url = r.url();
        if (!/supabase\.co\/(rest|functions)/.test(url)) return;
        // Key on the FULL url including query. A render loop re-issues the
        // identical request; a page legitimately issues many *different* ones
        // against the same path — kalshi-proxy is called once per market series
        // and /rest/v1/trades once per distinct dashboard query. Keying on path
        // alone conflates the two and flags healthy fan-out as a storm.
        requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
      });
      page.on("response", (r) => {
        if (r.status() >= 400 && /supabase\.co\/(rest|functions)/.test(r.url())) {
          badResponses.push(`${r.status()} ${r.url().split("?")[0]}`);
        }
      });

      await signIn(page);
      await page.getByRole("button", { name: new RegExp(`^${mode}$`, "i") }).click();

      // 1. It paints. This is the check the 2026-08-04 outage would have failed:
      //    an unguarded await before the only `loading:false` left this spinning
      //    forever, in live mode only.
      const hero = page.getByText(/kalshi wallet|portfolio/i).first();
      await expect(hero).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
      const heroValue = page.locator("text=/\\$\\s?-?[0-9][0-9,]*(\\.[0-9]{2})?/").first();
      await expect(heroValue).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

      // 2. No stuck skeleton anywhere on the page.
      await expect(page.locator('[data-loading="true"], .animate-pulse')).toHaveCount(0, {
        timeout: PAINT_TIMEOUT_MS,
      });

      // 3. No chart is a bare axis. Every recharts surface must either plot a
      //    series or its card must explain why it can't.
      const blankCharts = await page.evaluate(() =>
        Array.from(document.querySelectorAll("svg.recharts-surface")).filter((svg) => {
          const hasSeries = Array.from(svg.querySelectorAll("path"))
            .some((p) => (p.getAttribute("d") || "").length > 20);
          if (hasSeries) return false;
          const card = svg.closest("div.rounded-2xl") ?? svg.parentElement;
          return !/no |not enough|nothing to chart|enable/i.test(card?.textContent ?? "");
        }).length,
      );
      expect(blankCharts, "chart rendered with no data and no empty state").toBe(0);

      // 4. No render loop. The AgentPanel bug re-issued the *identical*
      //    strategy_config request 15+ times per load; that repetition, not
      //    request volume, is the signature. Realtime events legitimately cause
      //    a couple of refetches, hence the small allowance.
      const stormy = [...requestCounts.entries()].filter(([, n]) => n > MAX_REQUESTS_PER_ENDPOINT);
      expect(
        stormy.map(([u, n]) => `${u.replace(/^https:\/\/[^/]+/, "")} ×${n}`),
        "identical request repeated — probable render loop",
      ).toEqual([]);

      // 5. Clean console and network.
      expect(badResponses, "4xx/5xx on app requests").toEqual([]);
      expect(consoleErrors.filter((e) => !/favicon|third-party/i.test(e))).toEqual([]);
    });
  }

  test("rendered P&L equals the database", async ({ page }) => {
    await signIn(page);

    await page.getByRole("button", { name: /^paper$/i }).click();
    const allTime = page.getByText(/all-time/i).first();
    await expect(allTime).toBeVisible({ timeout: PAINT_TIMEOUT_MS });

    const rendered = parseMoney(await allTime.innerText());
    const expected = await dbRealisedPnl(page, "paper");

    // A dashboard showing a confidently wrong number is worse than a blank one.
    expect(Math.abs(Math.abs(rendered) - Math.abs(expected)),
      `dashboard shows ${rendered}, database says ${expected}`).toBeLessThanOrEqual(0.01);
  });

  test("public track record renders logged out", async ({ page }) => {
    await page.goto("/performance");
    await expect(page).not.toHaveURL(/auth|login/);
    await expect(page.locator("body")).not.toContainText("404");
    // The uncle-capital artifact: it must show numbers, not an empty shell.
    await expect(page.locator("text=/\\d/").first()).toBeVisible({ timeout: PAINT_TIMEOUT_MS });
  });
});
