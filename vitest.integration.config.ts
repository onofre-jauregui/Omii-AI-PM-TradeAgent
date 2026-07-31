import { defineConfig } from "vitest/config";
import path from "path";

// Separate config for the integration test tier (supabase/functions/tests/integration/
// *.integration.test.ts) — these hit real deployed edge functions over the network as
// the dedicated E2E test account, paper mode only. Deliberately NOT jsdom (no DOM
// needed, these are server-to-server HTTP calls) and NOT included in the default
// `npm test` run (see vitest.config.ts's exclude) since they require network access
// and E2E test-account secrets that aren't present in every environment that runs
// `npm test`. Run via `npm run test:integration` with those secrets set.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["supabase/functions/tests/integration/**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
