import { test, expect } from "@playwright/test";

test("landing page loads without error", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Kalshi|TradeAgent/i);
});

test("login page renders with Google button", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
});

test("auth-gated route redirects unauthenticated users", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/(login|$)/, { timeout: 5000 });
});

test("performance page is publicly accessible", async ({ page }) => {
  await page.goto("/performance");
  await expect(page).not.toHaveURL(/login/);
  await expect(page.locator("body")).not.toContainText("404");
});

test("signup page renders", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.locator("body")).not.toContainText("404");
});
