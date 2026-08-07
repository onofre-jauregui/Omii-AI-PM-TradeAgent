import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// The Supabase Edge Gateway rejects any request without an Authorization header
// (401 UNAUTHORIZED_NO_AUTH_HEADER) before the function body ever runs. A raw
// fetch() that forgets it fails 100% of the time, which is how the public
// waitlist form silently stopped capturing signups for ~11 weeks (0057f03 swapped
// an auto-authenticated supabase-js insert for a bare fetch). Public endpoints
// send the anon/publishable key; user-scoped ones send the session token — but
// every call site must send something.

const SRC = path.resolve(__dirname, "..");
const EDGE_FN_PATH = "functions/v1/";
const WINDOW_LINES = 14;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Const names bound to an edge-function URL, e.g. `const AGENT_URL = ...functions/v1/trading-agent` */
function edgeUrlConsts(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*functions\/v1\//g;
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

function findUnauthenticatedCalls(source: string, consts: Set<string>): number[] {
  const lines = source.split("\n");
  const offenders: number[] = [];

  lines.forEach((line, index) => {
    if (!line.includes("fetch(")) return;
    const window = lines.slice(index, index + WINDOW_LINES).join("\n");
    const targetsEdgeFn =
      window.includes(EDGE_FN_PATH) ||
      [...consts].some((name) => new RegExp(`fetch\\(\\s*\`?\\$?\\{?${name}\\b`).test(window));
    if (!targetsEdgeFn) return;
    // Header keys appear both bare and quoted across the codebase.
    if (!/["']?Authorization["']?\s*:/.test(window)) offenders.push(index + 1);
  });

  return offenders;
}

describe("edge function call sites", () => {
  const files = sourceFiles(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every fetch() to a Supabase edge function sends an Authorization header", () => {
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (!source.includes(EDGE_FN_PATH)) return [];
      return findUnauthenticatedCalls(source, edgeUrlConsts(source)).map(
        (line) => `${path.relative(SRC, file)}:${line}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
