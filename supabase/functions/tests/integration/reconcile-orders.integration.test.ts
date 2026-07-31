import { describe, it, expect } from "vitest";
import { functionUrl } from "./helpers.ts";

/**
 * Smoke coverage only for reconcile-orders (DESIGN-REPORT.md EF13,
 * HIGH-STAKES). Unlike paper-reconcile, this function only processes LIVE
 * resting Kalshi orders — deliberately out of scope for deeper integration
 * testing per this session's plan (no real live order placement in CI; see
 * DESIGN-REPORT.md §5's follow-up decision on wiring Kalshi's demo
 * environment). This proves the function is at least callable and returns a
 * structured response — the exact failure class execute-basket had
 * (missing baskets.user_id) before this session's audit.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

describe("reconcile-orders (integration, smoke only)", () => {
  it("is callable and returns a well-formed response", async () => {
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const resp = await fetch(functionUrl("reconcile-orders"), {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: requireEnv("SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toBeTypeOf("object");
  });
});
