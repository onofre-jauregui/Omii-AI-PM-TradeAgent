import { describe, expect, it } from "vitest";
import { applyMemoryTenantFilter, type MemoryScope } from "./memory-scope.ts";

/** Chainable stand-in for a PostgREST builder that records every filter applied. */
function recordingQuery() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = { calls };
  for (const op of ["eq", "is", "or"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return builder;
    };
  }
  return builder as { calls: typeof calls } & Record<string, never>;
}

const OWNER = "ea207ba1-b7a9-4a7b-96bc-922e922d627d";
const OTHER = "7f3c1d92-0b64-4f18-9a2e-5c8d4e6a1b30";

describe("applyMemoryTenantFilter", () => {
  it("scopes to the owner plus platform rows by default", () => {
    const q = recordingQuery();
    applyMemoryTenantFilter(q, { userId: OWNER });
    expect(q.calls).toEqual([
      { op: "or", args: [`user_id.is.null,user_id.eq.${OWNER}`] },
    ]);
  });

  it("excludes platform rows when includePlatform is false", () => {
    const q = recordingQuery();
    applyMemoryTenantFilter(q, { userId: OWNER, includePlatform: false });
    expect(q.calls).toEqual([{ op: "eq", args: ["user_id", OWNER] }]);
  });

  it("restricts an ownerless run to platform rows, never to all rows", () => {
    const q = recordingQuery();
    applyMemoryTenantFilter(q, { userId: null });
    expect(q.calls).toEqual([{ op: "is", args: ["user_id", null] }]);
  });

  it("always applies exactly one filter — no scope is ever a no-op", () => {
    const scopes: MemoryScope[] = [
      { userId: OWNER },
      { userId: OWNER, includePlatform: false },
      { userId: null },
      { userId: null, includePlatform: false },
    ];
    for (const scope of scopes) {
      const q = recordingQuery();
      applyMemoryTenantFilter(q, scope);
      expect(q.calls).toHaveLength(1);
    }
  });

  it("never emits a filter naming a user other than the scoped owner", () => {
    const q = recordingQuery();
    applyMemoryTenantFilter(q, { userId: OWNER });
    expect(JSON.stringify(q.calls)).not.toContain(OTHER);
  });

  // The or= value is a filter-tree parser context: a "," or ")" in the id would
  // rewrite the tree and silently widen the scope. Reject before that can happen.
  it.each([
    ["comma injection", `${OWNER},user_id.not.is.null`],
    ["paren injection", `${OWNER})`],
    ["empty string", ""],
    ["non-uuid", "admin"],
  ])("throws on a %s user_id rather than widening scope", (_label, bad) => {
    const q = recordingQuery();
    expect(() => applyMemoryTenantFilter(q, { userId: bad })).toThrow(
      /non-UUID user_id/,
    );
    expect(q.calls).toHaveLength(0);
  });
});
