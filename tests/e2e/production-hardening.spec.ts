/**
 * Production hardening E2E tests.
 *
 * These tests verify the live mode banner and core security invariants
 * without requiring real Supabase credentials. All tests run against the
 * dev server (unauthenticated paths only), or against a mocked auth state
 * where applicable.
 */

import { test, expect, type Page } from "@playwright/test";

// ─── Unauthenticated / public surface tests ──────────────────────────────────

test.describe("Public surface — no regressions", () => {
  test("landing page loads and title is correct", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Kalshi|TradeAgent/i);
  });

  test("landing page has no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/");
    await page.waitForTimeout(1500);
    // Tolerate Supabase auth/network errors in unauthenticated context
    const blocking = errors.filter(e =>
      !e.includes("supabase") &&
      !e.includes("auth") &&
      !e.includes("Failed to fetch") &&
      !e.includes("net::")
    );
    expect(blocking).toHaveLength(0);
  });

  test("auth-gated route redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL(/\/(login|$)/, { timeout: 5000 });
  });

  test("terms and privacy pages are accessible", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator("body")).not.toContainText("404");
    await page.goto("/privacy");
    await expect(page.locator("body")).not.toContainText("404");
  });

  test("performance page is publicly accessible without auth", async ({ page }) => {
    await page.goto("/performance");
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator("body")).not.toContainText("404");
  });
});

// ─── Auth page ───────────────────────────────────────────────────────────────

test.describe("Auth page", () => {
  test("login page renders", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("body")).not.toContainText("404");
  });

  test("signup page renders", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.locator("body")).not.toContainText("404");
  });
});

// ─── Live mode UI invariants (component-level, no auth) ──────────────────────

test.describe("Live mode UI", () => {
  /**
   * Verifies the live mode banner exists in the bundle and has the
   * correct markup structure. Doesn't require a logged-in session.
   */

  test("live mode banner component is in the JS bundle", async ({ page }) => {
    await page.goto("/");
    // Works in both Vite dev mode (source files served individually) and production (bundled)
    const found = await page.evaluate(async () => {
      // Production: scan bundled scripts
      const scripts = Array.from(document.querySelectorAll("script[src]"));
      for (const s of scripts) {
        try {
          const r = await fetch((s as HTMLScriptElement).src);
          const t = await r.text();
          if (t.includes("LIVE MODE") || t.includes("LiveModeBanner")) return true;
        } catch {}
      }
      // Dev (Vite): check source file directly
      try {
        const r = await fetch("/src/components/trading/LiveModeBanner.tsx");
        if (r.ok) return (await r.text()).includes("LiveModeBanner");
      } catch {}
      return false;
    });
    expect(found).toBe(true);
  });
});

// ─── Security headers / CSP smoke ────────────────────────────────────────────

test.describe("Security headers", () => {
  test("landing page response is 200", async ({ request }) => {
    const resp = await request.get("/");
    expect(resp.status()).toBe(200);
  });

  test("no sensitive data exposed in landing page HTML", async ({ page }) => {
    const content = await page.goto("/").then(r => r?.text() ?? "");
    // Keys, secrets, and connection strings must never appear in the HTML
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/); // OpenAI key pattern
    expect(content).not.toMatch(/eyJ[A-Za-z0-9._-]{50,}/); // JWT
    expect(content).not.toMatch(/supabase\.co\/rest\//); // Supabase REST URL in plain HTML
  });
});

// ─── Mobile viewport smoke ───────────────────────────────────────────────────

test.describe("Mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 812 } }); // iPhone 14

  test("landing page renders on mobile without horizontal scroll", async ({ page }) => {
    await page.goto("/");
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2); // 2px tolerance
  });

  test("login page renders on mobile", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("body")).not.toContainText("404");
  });
});

// ─── Accessibility smoke ──────────────────────────────────────────────────────

test.describe("Accessibility — critical ARIA", () => {
  test("landing page has a <main> element", async ({ page }) => {
    await page.goto("/");
    const main = page.locator("main");
    // Either a <main> exists or the page is auth-redirecting — both are acceptable
    const url = page.url();
    if (!url.includes("login")) {
      await expect(main.first()).toBeAttached();
    }
  });

  test("interactive elements have accessible labels", async ({ page }) => {
    await page.goto("/login");
    // All buttons must have accessible text
    const buttons = page.getByRole("button");
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const text = (await btn.textContent())?.trim() ?? "";
      const ariaLabel = await btn.getAttribute("aria-label") ?? "";
      expect(text.length + ariaLabel.length).toBeGreaterThan(0);
    }
  });
});
