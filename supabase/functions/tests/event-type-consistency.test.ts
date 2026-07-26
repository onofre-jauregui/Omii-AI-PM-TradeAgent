// @vitest-environment node
//
// Regression guard for a recurring bug class, not one incident: four separate
// silent-failure bugs this week (health-check's diagnostic_needed queue,
// checkLiquidity's dropped compliance-log calls, and auto-reflect's compaction
// cooldown reading "memory_compaction_run" while compact-memory writes
// "memory_compaction") were all the same shape — a read site's event_type
// string literal didn't match any write site's literal, so the read always
// returned zero rows and failed silently (no error, no alert, just a gate
// that never engaged). Each was found by manually diffing every write
// literal against every read literal in compliance_log. This test automates
// that diff so a future typo/rename fails CI instead of shipping silent for
// months.
//
// Static text scan, not a live DB query: reads the .ts sources directly so
// this has no Supabase/network dependency and matches the project's existing
// import-free test convention (see kalshi-signing.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FUNCTIONS_DIR = join(__dirname, "..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "tests" || entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const WRITE_PATTERN = /event_type:\s*["']([a-zA-Z0-9_]+)["']/g;
const READ_PATTERNS = [
  /\.eq\(\s*["']event_type["']\s*,\s*["']([a-zA-Z0-9_]+)["']\s*\)/g,
  /event_type\s*===\s*["']([a-zA-Z0-9_]+)["']/g,
  /event_type\s*==\s*["']([a-zA-Z0-9_]+)["']/g,
];

function collect(files: string[], patterns: RegExp[]): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const rel = relative(FUNCTIONS_DIR, file);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const value = match[1];
        const list = hits.get(value) ?? [];
        list.push(rel);
        hits.set(value, list);
      }
    }
  }
  return hits;
}

describe("compliance_log event_type consistency", () => {
  const files = listTsFiles(FUNCTIONS_DIR);
  const writes = collect(files, [WRITE_PATTERN]);
  const reads = collect(files, READ_PATTERNS);

  it("found write sites to check against (sanity check the scan itself works)", () => {
    expect(writes.size).toBeGreaterThan(10);
  });

  it("every event_type a read site filters on is actually written somewhere", () => {
    const orphaned: string[] = [];
    for (const [value, readFiles] of reads) {
      if (!writes.has(value)) {
        orphaned.push(`"${value}" — read in ${readFiles.join(", ")}, never written by any event_type: literal`);
      }
    }
    expect(orphaned, orphaned.join("\n")).toEqual([]);
  });
});
