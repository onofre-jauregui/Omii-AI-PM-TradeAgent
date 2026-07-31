import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "supabase/functions/**/*.{test,spec}.ts",
    ],
    // *.integration.test.ts files hit real deployed edge functions over the
    // network and require E2E test-account secrets that aren't present in the
    // default `npm test` environment (every push/PR, Job 1) — they run
    // separately via `npm run test:integration` (vitest.integration.config.ts)
    // where those secrets are provided. See
    // supabase/functions/tests/integration/helpers.ts for the required env vars.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
