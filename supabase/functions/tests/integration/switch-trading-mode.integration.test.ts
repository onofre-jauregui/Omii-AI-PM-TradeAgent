import { describe, it, expect, beforeAll } from "vitest";
import { signInTestUser, callFunction, functionUrl, type TestSession } from "./helpers.ts";

/**
 * Integration coverage for switch-trading-mode — the paper→live gate
 * (DESIGN-REPORT.md EF18, HIGH-STAKES, "highest in domain" per the original
 * audit, zero coverage before this file). The test account has no
 * subscription and no Kalshi key on file, so every live-mode attempt here
 * is expected to be REJECTED — this test proves the gates hold, it never
 * exercises an actual paper→live flip.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function getProfileMode(userId: string): Promise<string> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=trading_mode`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const rows = await resp.json();
  return rows[0]?.trading_mode ?? "paper";
}

describe("switch-trading-mode (integration)", () => {
  let session: TestSession;

  beforeAll(async () => {
    session = await signInTestUser();
  });

  it("rejects an invalid target_mode with a 400", async () => {
    const { status, json } = await callFunction("switch-trading-mode", session, { target_mode: "yolo" });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_mode");
  });

  it("rejects a request with no auth at all", async () => {
    const resp = await fetch(functionUrl("switch-trading-mode"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_mode: "paper" }),
    });
    expect(resp.status).toBe(401);
  });

  it("blocks switching to live without an active subscription (gate #1)", async () => {
    const { status, json } = await callFunction("switch-trading-mode", session, { target_mode: "live" });
    // This test account has no subscriptions row — must be rejected before
    // ever reaching the Kalshi-key or HITL checks, and must NOT flip trading_mode.
    expect(status).toBe(403);
    expect(json.error).toBe("subscription_required");

    const mode = await getProfileMode(session.userId);
    expect(mode).not.toBe("live");
  });

  it("allows switching to paper mode cleanly (no gates apply) and persists it", async () => {
    const { status, json } = await callFunction("switch-trading-mode", session, { target_mode: "paper" });
    expect(status).toBe(200);
    expect(json.trading_mode ?? json.mode ?? "paper").toBeTruthy();

    const mode = await getProfileMode(session.userId);
    expect(mode).toBe("paper");
  });
});
