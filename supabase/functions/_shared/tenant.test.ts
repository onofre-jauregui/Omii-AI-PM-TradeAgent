import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTenant,
  getRiskSettings,
  getRiskStateToday,
  setRiskHalt,
  applyTenantFilter,
  tenantInsertFields,
} from "./tenant.ts";

// tenant.ts is the sole multi-tenancy enforcement boundary once an edge
// function's service-role client bypasses RLS — every function that queries
// user-scoped tables is supposed to route through these helpers instead of
// filtering ad hoc. It had zero test coverage before this file, confirmed
// during the 2026-07-30 production-readiness audit (DESIGN-REPORT.md #6).

/** Minimal chainable/awaitable Supabase query-builder mock. Every builder
 *  method records its call and returns the same object so it can be chained
 *  arbitrarily deep; the object is also thenable so `await` works whether
 *  the caller awaits an intermediate step (e.g. a bare `.eq()`) or a
 *  terminal one (e.g. `.maybeSingle()`) — tenant.ts does both depending on
 *  the function. */
function makeQueryBuilder(result: { data?: any; error?: any } = { data: null, error: null }) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const builder: any = { _calls: calls };
  for (const method of ["from", "select", "eq", "is", "update", "insert", "maybeSingle"]) {
    builder[method] = (...args: any[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function callsFor(builder: any, method: string) {
  return builder._calls.filter((c: any) => c.method === method);
}

describe("resolveTenant", () => {
  const serviceKey = "service-role-key-abc";

  beforeEach(() => {
    // resolveTenant reads Deno.env.get directly (this module runs as a Deno
    // edge function in production) — vitest runs under Node, where no Deno
    // global exists, so it must be stubbed for these tests.
    vi.stubGlobal("Deno", { env: { get: (key: string) => (key === "SUPABASE_SERVICE_ROLE_KEY" ? serviceKey : undefined) } });
  });

  it("resolves userId from a verified JWT", async () => {
    const supabase = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }) } };
    const req = new Request("https://x.test/fn", { headers: { Authorization: "Bearer real-user-jwt" } });
    const result = await resolveTenant(req, supabase as any);
    expect(result).toEqual({ userId: "user-1", authenticated: true });
    expect(supabase.auth.getUser).toHaveBeenCalledWith("real-user-jwt");
  });

  it("skips JWT verification when the bearer is exactly the service role key (cron/system calls)", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const req = new Request("https://x.test/fn", { headers: { Authorization: `Bearer ${serviceKey}` } });
    const result = await resolveTenant(req, supabase as any);
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
    expect(result).toEqual({ userId: null, authenticated: false });
  });

  it("falls through to the legacy default tenant when the JWT fails verification", async () => {
    const supabase = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "invalid" } }) } };
    const req = new Request("https://x.test/fn", { method: "GET", headers: { Authorization: "Bearer garbage" } });
    const result = await resolveTenant(req, supabase as any);
    expect(result).toEqual({ userId: null, authenticated: false });
  });

  it("uses an explicit user_id from a pre-parsed body when no JWT is present, marked unauthenticated", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const req = new Request("https://x.test/fn", { method: "POST" });
    const result = await resolveTenant(req, supabase as any, { user_id: "admin-supplied-user" });
    expect(result).toEqual({ userId: "admin-supplied-user", authenticated: false });
  });

  it("a verified JWT always wins over a body user_id, even if they differ", async () => {
    const supabase = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "jwt-user" } }, error: null }) } };
    const req = new Request("https://x.test/fn", { method: "POST", headers: { Authorization: "Bearer real-jwt" } });
    const result = await resolveTenant(req, supabase as any, { user_id: "someone-else" });
    expect(result).toEqual({ userId: "jwt-user", authenticated: true });
  });

  it("reads user_id from the request body itself when no parsedBody is passed (POST)", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const req = new Request("https://x.test/fn", {
      method: "POST",
      body: JSON.stringify({ user_id: "body-user" }),
      headers: { "Content-Type": "application/json" },
    });
    const result = await resolveTenant(req, supabase as any);
    expect(result).toEqual({ userId: "body-user", authenticated: false });
  });

  it("resolves to the legacy null tenant for a GET request with no auth and no body", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const req = new Request("https://x.test/fn", { method: "GET" });
    const result = await resolveTenant(req, supabase as any);
    expect(result).toEqual({ userId: null, authenticated: false });
  });

  it("resolves to the legacy null tenant when the POST body is empty/malformed JSON", async () => {
    const supabase = { auth: { getUser: vi.fn() } };
    const req = new Request("https://x.test/fn", { method: "POST", body: "not-json" });
    const result = await resolveTenant(req, supabase as any);
    expect(result).toEqual({ userId: null, authenticated: false });
  });
});

describe("applyTenantFilter", () => {
  it("filters by user_id when a userId is provided", () => {
    const builder = makeQueryBuilder();
    applyTenantFilter(builder, "user-42");
    expect(callsFor(builder, "eq")).toEqual([{ method: "eq", args: ["user_id", "user-42"] }]);
    expect(callsFor(builder, "is")).toHaveLength(0);
  });

  it("filters to the legacy NULL tenant when userId is null", () => {
    const builder = makeQueryBuilder();
    applyTenantFilter(builder, null);
    expect(callsFor(builder, "is")).toEqual([{ method: "is", args: ["user_id", null] }]);
    expect(callsFor(builder, "eq")).toHaveLength(0);
  });
});

describe("tenantInsertFields", () => {
  it("wraps a real userId", () => {
    expect(tenantInsertFields("user-1")).toEqual({ user_id: "user-1" });
  });

  it("wraps null for the legacy tenant", () => {
    expect(tenantInsertFields(null)).toEqual({ user_id: null });
  });
});

describe("getRiskSettings", () => {
  it("scopes to user_id + mode and returns the row", async () => {
    const row = { user_id: "user-1", mode: "live", allocated_capital: 1000 };
    const builder = makeQueryBuilder({ data: row, error: null });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    const result = await getRiskSettings(supabase as any, "user-1", "live");
    expect(result).toEqual(row);
    expect(callsFor(builder, "eq")).toContainEqual({ method: "eq", args: ["mode", "live"] });
    expect(callsFor(builder, "eq")).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("scopes to the legacy NULL tenant when userId is null", async () => {
    const builder = makeQueryBuilder({ data: { mode: "paper" }, error: null });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    await getRiskSettings(supabase as any, null, "paper");
    expect(callsFor(builder, "is")).toContainEqual({ method: "is", args: ["user_id", null] });
  });

  it("fails closed (returns null) and logs loudly on a query error, rather than silently returning null with no trace", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const builder = makeQueryBuilder({ data: null, error: { message: "multiple rows returned" } });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    const result = await getRiskSettings(supabase as any, "user-1", "live");
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns null when no row exists for this (user_id, mode)", async () => {
    const builder = makeQueryBuilder({ data: null, error: null });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    const result = await getRiskSettings(supabase as any, "user-1", "live");
    expect(result).toBeNull();
  });
});

describe("getRiskStateToday", () => {
  it("scopes to user_id + today's date", async () => {
    const row = { is_trading_halted: true };
    const builder = makeQueryBuilder({ data: row, error: null });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    const result = await getRiskStateToday(supabase as any, "user-1");
    expect(result).toEqual(row);
    expect(callsFor(builder, "eq")).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("returns null when no row exists yet today", async () => {
    const builder = makeQueryBuilder({ data: null, error: null });
    const supabase = { from: vi.fn().mockReturnValue(builder) };
    const result = await getRiskStateToday(supabase as any, "user-1");
    expect(result).toBeNull();
  });
});

describe("setRiskHalt", () => {
  it("updates the existing row for today when one exists, setting halt_reason", async () => {
    const selectBuilder = makeQueryBuilder({ data: { id: "risk-state-1" }, error: null });
    const updateBuilder = makeQueryBuilder({ error: null });
    const supabase = {
      from: vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    };
    const { error } = await setRiskHalt(supabase as any, "user-1", true, "daily loss limit hit");
    expect(error).toBeNull();
    expect(callsFor(updateBuilder, "update")[0].args[0]).toMatchObject({
      is_trading_halted: true,
      halt_reason: "daily loss limit hit",
    });
    expect(callsFor(updateBuilder, "eq")).toEqual([{ method: "eq", args: ["id", "risk-state-1"] }]);
  });

  it("inserts a new row scoped to user_id + today when none exists yet", async () => {
    const selectBuilder = makeQueryBuilder({ data: null, error: null });
    const insertBuilder = makeQueryBuilder({ error: null });
    const supabase = {
      from: vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(insertBuilder),
    };
    await setRiskHalt(supabase as any, "user-2", true, "kill switch");
    const insertPayload = callsFor(insertBuilder, "insert")[0].args[0];
    expect(insertPayload).toMatchObject({ user_id: "user-2", is_trading_halted: true, halt_reason: "kill switch" });
    expect(insertPayload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("clears halt_reason to null when un-halting", async () => {
    const selectBuilder = makeQueryBuilder({ data: { id: "risk-state-1" }, error: null });
    const updateBuilder = makeQueryBuilder({ error: null });
    const supabase = {
      from: vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    };
    await setRiskHalt(supabase as any, "user-1", false, "should be ignored");
    expect(callsFor(updateBuilder, "update")[0].args[0]).toMatchObject({
      is_trading_halted: false,
      halt_reason: null,
    });
  });
});
