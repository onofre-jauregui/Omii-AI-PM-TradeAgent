import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The CORS spec requires Access-Control-Allow-Origin to be a single value, so a
// multi-origin allow-list only works if each request's own origin is reflected
// back. Helpers that resolve the origin without seeing the request necessarily
// pin every response to the FIRST entry in the list — which silently refuses
// staging, the vercel.app previews, and localhost while production keeps
// working. That asymmetry is what let a 100%-failing waitlist form go
// unnoticed for eleven weeks: the one origin that could exercise it was the
// one nobody tests against.

const SAFE_ORIGINS = [
  "https://kalshitradeagent.com",
  "https://kalshitradeagent.live",
  "https://omii-trade-agent.vercel.app",
  "https://omii-ai-pm-trade-agent.vercel.app",
  "http://localhost:5173",
];

async function loadCors() {
  // cors.ts reads Deno.env at module scope, so the stub must exist before import
  // and the module registry must be reset between env permutations.
  vi.resetModules();
  vi.stubGlobal("Deno", { env: { get: () => undefined } });
  return await import("./cors.ts");
}

describe("makeCorsHeaders", () => {
  beforeEach(() => {
    vi.stubGlobal("Deno", { env: { get: () => undefined } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reflects every origin on the allow-list back to itself", async () => {
    const { makeCorsHeaders } = await loadCors();
    for (const origin of SAFE_ORIGINS) {
      expect(makeCorsHeaders(origin)["Access-Control-Allow-Origin"]).toBe(origin);
    }
  });

  it("does not reflect an origin that is not on the allow-list", async () => {
    const { makeCorsHeaders } = await loadCors();
    const evil = "https://attacker.example.com";
    expect(makeCorsHeaders(evil)["Access-Control-Allow-Origin"]).not.toBe(evil);
  });

  it("advertises the apikey and authorization headers the gateway requires", async () => {
    const { makeCorsHeaders } = await loadCors();
    const allowed = makeCorsHeaders("https://kalshitradeagent.live")["Access-Control-Allow-Headers"];
    expect(allowed).toContain("apikey");
    expect(allowed).toContain("authorization");
  });
});

describe("preflight", () => {
  beforeEach(() => {
    vi.stubGlobal("Deno", { env: { get: () => undefined } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reflects the requesting origin when handed the Request", async () => {
    const { preflight } = await loadCors();
    const req = new Request("https://example.test", {
      method: "OPTIONS",
      headers: { origin: "https://kalshitradeagent.live" },
    });
    expect(preflight(req).headers.get("Access-Control-Allow-Origin")).toBe(
      "https://kalshitradeagent.live",
    );
  });

  it("pins to the first allowed origin when called with no Request — the bug shape", async () => {
    const { preflight } = await loadCors();
    // Documents why every browser-facing function must pass `req`: with no
    // request there is nothing to reflect, so non-production origins are refused.
    expect(preflight().headers.get("Access-Control-Allow-Origin")).toBe(SAFE_ORIGINS[0]);
  });
});
