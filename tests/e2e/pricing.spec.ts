/**
 * Pricing truth gate.
 *
 * The landing page and the billing page each carried their own hand-written
 * pricing table until 2026-08-06. They drifted, and the landing copy advertised
 * limits the server does not grant — "No position size limits" on a tier the
 * server caps at $25/position, "No position size cap" on one capped at $100 —
 * while omitting the $999 tier entirely. Nothing in the E2E suite had ever
 * looked at pricing, so none of it failed a test.
 *
 * src/lib/pricing.ts is now the single table both surfaces render, and
 * src/lib/pricing.test.ts pins it to the server's TIER_DEFINITIONS. That guards
 * the data. This guards the rendered result on the deployed build: that the
 * cards actually mount, and that what a customer reads is what the table says.
 *
 * It doubles as a staleness detector. Job 4's readiness check is a curl for
 * HTTP 200, which a previous deploy answers just as happily — so the suite can
 * grade yesterday's build. Asserting current tier content fails loudly instead.
 *
 * Signed-in coverage requires only E2E_USER_EMAIL / E2E_USER_PASSWORD, and
 * skips rather than fails when unset so local runs stay green.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  PAID_TIERS,
  PRICING_TIERS,
  tierFeatures,
  tierPriceLabel,
} from "../../src/lib/pricing";

const EMAIL = process.env.E2E_USER_EMAIL ?? process.env.TRADEAGENT_E2E_TEST_USER_EMAIL;
const PASSWORD = process.env.E2E_USER_PASSWORD ?? process.env.TRADEAGENT_E2E_TEST_USER_PASSWORD;
const HAVE_CREDS = Boolean(EMAIL && PASSWORD);

/** Internal strategy identifiers. A prospect cannot evaluate "S-002"; naming one
 *  also ties public pricing to a roster that changes without a pricing change. */
const STRATEGY_ID = /S-\d{3}/;
/** The exact shape of the claims that shipped: an unbounded-position promise. */
const UNBOUNDED_CLAIM = /unlimited|no position size/i;

async function signIn(page: Page) {
  // Target inputs by type, not by label — same reasoning as dashboard-truth.spec.ts:
  // a login helper that breaks on a copy change produces false failures.
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"]').first().fill(PASSWORD!);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !/\/(login|auth)/.test(url.pathname), { timeout: 30_000 });
  await page.locator("main").first().waitFor({ timeout: 30_000 });
}

/** Every string a tier's card must show, including its price. */
function expectedCardContent(tier: (typeof PRICING_TIERS)[number]): string[] {
  return [tierPriceLabel(tier), ...tierFeatures(tier)];
}

async function expectNoFalseClaims(region: Locator, label: string) {
  const text = await region.innerText();
  expect(text, `${label} names an internal strategy id`).not.toMatch(STRATEGY_ID);
  expect(text, `${label} promises an unbounded position size`).not.toMatch(UNBOUNDED_CLAIM);
}

test.describe("pricing truth", () => {
  test("landing page renders every tier exactly as the pricing table defines it", async ({ page }) => {
    await page.goto("/");
    const grid = page.locator("#pricing .grid");
    await expect(grid).toBeVisible({ timeout: 15_000 });

    // A missing tier is how the $999 plan went unsold on the landing page for
    // months while /billing offered it.
    await expect(grid.locator("> *")).toHaveCount(PRICING_TIERS.length);

    for (const [i, tier] of PRICING_TIERS.entries()) {
      const card = grid.locator("> *").nth(i);
      for (const line of expectedCardContent(tier)) {
        await expect(card, `${tier.id} card missing "${line}"`).toContainText(line);
      }
    }

    // Scoped to the pricing section, not the whole page: a future changelog or
    // methodology section may legitimately name a strategy.
    await expectNoFalseClaims(page.locator("#pricing"), "landing pricing section");
  });

  test("landing page badges exactly one tier as most popular", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#pricing").getByText(/most popular/i)).toHaveCount(1);
  });

  test.describe("signed in", () => {
    test.skip(!HAVE_CREDS, "E2E_USER_EMAIL / E2E_USER_PASSWORD not set");

    test("billing page shows the same paid tiers at the same prices", async ({ page }) => {
      await signIn(page);
      await page.goto("/billing");

      const grid = page.locator(".grid").first();
      await expect(grid).toBeVisible({ timeout: 15_000 });
      await expect(grid.locator("> *")).toHaveCount(PAID_TIERS.length);

      for (const [i, tier] of PAID_TIERS.entries()) {
        const card = grid.locator("> *").nth(i);
        for (const line of expectedCardContent(tier)) {
          await expect(card, `${tier.id} plan missing "${line}"`).toContainText(line);
        }
      }

      await expectNoFalseClaims(page.locator("body"), "billing page");
    });
  });
});
