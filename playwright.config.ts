import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8080",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // PW_CHANNEL=chrome runs the suite against a locally installed Chrome
      // instead of Playwright's bundled build. Unset everywhere by default, so
      // CI is unaffected; it exists because the bundled download fails on some
      // machines and "can't install a browser" should not mean "can't run the
      // gate that has to pass before merging."
      use: { ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) },
    },
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: "npm run dev",
    url: "http://localhost:8080",
    reuseExistingServer: !process.env.CI,
  },
});
