/**
 * Dashboard tab persistence — functional gate.
 *
 * Unit tests cover the storage module in isolation; they cannot prove that the
 * dashboard actually reopens on the tab a user left on, because that depends on
 * mount order, the auth callback, and the persistence effect all agreeing. This
 * suite drives the real signed-in app and asserts the two behaviours the feature
 * exists to deliver:
 *
 *   1. Returning to the app (a reload, a PWA relaunch) reopens the last tab.
 *   2. A fresh sign-in is an initiation — it opens on the Dashboard, never on
 *      the previous session's tab.
 *
 * Both viewports are exercised because they render different navigation
 * components with different labels: desktop mounts Sidebar ("Dashboard"),
 * mobile mounts BottomNav ("Home"). The mobile case is the one that matters
 * most — returning to an installed PWA is the flow the feature was built for.
 *
 * Skips rather than fails when credentials are unset, so local runs stay green.
 */
import { expect, type Page, test } from "@playwright/test";

const EMAIL = process.env.E2E_USER_EMAIL ?? process.env.TRADEAGENT_E2E_TEST_USER_EMAIL;
const PASSWORD = process.env.E2E_USER_PASSWORD ?? process.env.TRADEAGENT_E2E_TEST_USER_PASSWORD;

const HAVE_CREDS = Boolean(EMAIL && PASSWORD);

const STORAGE_KEY = "kta:ui-state:v1";

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 800 }, homeLabel: "Dashboard" },
  { name: "mobile", size: { width: 390, height: 844 }, homeLabel: "Home" },
] as const;

/** Signs in through the real form and waits for the authenticated shell. */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill(EMAIL!);
  await page.locator('input[type="password"]').first().fill(PASSWORD!);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !/\/(login|auth)/.test(url.pathname), { timeout: 30_000 });
  await page.locator("main").first().waitFor({ timeout: 30_000 });
  // The nav mounts with the app shell; without it the first click can race.
  await currentTab(page).waitFor({ timeout: 30_000 });
}

/**
 * The nav button carrying aria-current="page" is the open tab. Deliberately not
 * scoped to <nav>: the desktop sidebar renders Settings outside its nav element.
 */
function currentTab(page: Page) {
  return page.locator('button[aria-current="page"]').first();
}

async function openTab(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await expect(currentTab(page)).toHaveText(new RegExp(label));
}

function readStoredState(page: Page, key: string) {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);
}

for (const viewport of VIEWPORTS) {
  test.describe(`dashboard tab persistence — ${viewport.name}`, () => {
    test.skip(!HAVE_CREDS, "E2E_USER_EMAIL / E2E_USER_PASSWORD not set");
    test.use({ viewport: viewport.size });

    test("reopens on the tab the user left on, and stamps it with the owner", async ({ page }) => {
      await signIn(page);
      await openTab(page, "Markets");

      // Polled, not read once: the write happens in an effect that runs after
      // the nav has already repainted, so a bare read races the render.
      await expect
        .poll(async () => (await readStoredState(page, STORAGE_KEY))?.activeTab, { timeout: 10_000 })
        .toBe("markets");
      // The stored row must carry the owning user id, otherwise the next session
      // cannot tell whose tab it is and a shared device leaks one user's view.
      const stored = await readStoredState(page, STORAGE_KEY);
      expect(typeof stored?.userId).toBe("string");
      expect(stored.userId.length).toBeGreaterThan(0);

      // A reload is the same code path as reopening the installed PWA.
      await page.reload();
      await page.locator("main").first().waitFor({ timeout: 30_000 });
      await expect(currentTab(page)).toHaveText(/Markets/);
    });

    test("a fresh sign-in opens on the Dashboard, not the previous tab", async ({ page }) => {
      // The account menu that holds Sign out is rendered only in the mobile
      // header — the desktop layout ships no sign-out control at all, so the
      // sign-out boundary can only be crossed the way a user would on mobile.
      test.skip(viewport.name !== "mobile", "no sign-out control in the desktop layout");
      await signIn(page);
      await openTab(page, "Settings");
      await expect
        .poll(async () => (await readStoredState(page, STORAGE_KEY))?.activeTab, { timeout: 10_000 })
        .toBe("settings");

      // Sign out through the real account menu — signing out is the initiation
      // boundary the app has to clear the stored tab on, so the test crosses it
      // the way a user does rather than by wiping storage itself.
      await page.locator('button[title="Account menu"]').click();
      await page.getByRole("menuitem", { name: /sign out/i }).click();
      // Signed out at "/" renders the landing page rather than redirecting, so
      // the signal is the authenticated shell going away, not a URL change.
      await expect(page.locator('button[aria-current="page"]')).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => readStoredState(page, STORAGE_KEY), { timeout: 10_000 })
        .toBeNull();

      await signIn(page);
      await expect(currentTab(page)).toHaveText(new RegExp(viewport.homeLabel));
    });
  });
}
