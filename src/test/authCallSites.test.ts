import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// `supabase.auth.signOut()` defaults to `scope: 'global'` — it revokes every
// session the user holds on every device, not just this browser's. The other
// devices learn about it when their next /auth/v1/user returns 403
// session_not_found, auth-js wipes localStorage, and the app drops them on the
// marketing page mid-session.
//
// Verified against the live project on 2026-08-08: with two tokens issued for
// one account, signing one out took the other from 200 to 403; with
// ?scope=local the other stayed 200.
//
// So sign-out goes through src/lib/auth.ts, which defaults to local. A direct
// call anywhere else silently reintroduces the bug — hence a static scan
// rather than a runtime test, matching edgeFunctionAuth.test.ts.

const SRC = path.resolve(__dirname, "..");
const SIGN_OUT_CALL = "supabase.auth.signOut(";

/** The one module allowed to call signOut directly, relative to src/. */
const SIGN_OUT_OWNER = "lib/auth.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [full] : [];
  });
}

function callLines(source: string, needle: string): number[] {
  return source
    .split("\n")
    .map((line, index) => (line.includes(needle) ? index + 1 : 0))
    .filter(Boolean);
}

describe("auth call sites", () => {
  const files = sourceFiles(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("only src/lib/auth.ts calls supabase.auth.signOut directly", () => {
    const violations = files.flatMap((file) => {
      const relative = path.relative(SRC, file);
      if (relative === SIGN_OUT_OWNER) return [];
      return callLines(readFileSync(file, "utf8"), SIGN_OUT_CALL).map(
        (line) => `${relative}:${line} — import { signOut } from "@/lib/auth" instead`,
      );
    });

    expect(violations).toEqual([]);
  });

  it("the wrapper defaults to local scope", () => {
    const source = readFileSync(path.join(SRC, SIGN_OUT_OWNER), "utf8");
    expect(source).toMatch(/scope:\s*"local"\s*\|\s*"global"\s*=\s*"local"/);
    expect(source).toContain("supabase.auth.signOut({ scope })");
  });
});
