import { describe, it, expect } from "vitest";
import { applyRiskBaselineFilter, computeMaxDrawdownPct } from "./strategy-health";

/** Chainable stand-in for a PostgREST builder that records every filter applied. */
function recordingQuery() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = { calls };
  for (const op of ["gte"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return builder;
    };
  }
  return builder as { calls: typeof calls } & Record<string, never>;
}

describe("computeMaxDrawdownPct", () => {
  it("stays bounded at or below 100% even with a tiny early peak and a large dollar swing", () => {
    // Reproduces the 2026-07-30/31 "Surface Arbitrage" S-001 incident: a small
    // early peak (~$23) followed by a deep dip, ending net +$125.23. The old
    // peak-cumulative-P&L formula reported 543.9% drawdown here.
    const pnls = [10, 13, -50, -60, 30, 40, 50, 40, 30, 22.23];
    const dd = computeMaxDrawdownPct(pnls, 1000);
    expect(dd).toBeGreaterThan(0);
    expect(dd).toBeLessThanOrEqual(1);
  });

  it("reports 0 drawdown for a strictly increasing P&L series", () => {
    const dd = computeMaxDrawdownPct([10, 20, 30, 40], 1000);
    expect(dd).toBe(0);
  });

  it("computes drawdown as a fraction of equity, not raw cumulative P&L", () => {
    // Starting balance $1000, dips to $900 (a real 10% drawdown), recovers.
    const dd = computeMaxDrawdownPct([-100, 200], 1000);
    expect(dd).toBeCloseTo(0.1, 5);
  });

  it("falls back to a base of 1 when starting balance is zero or missing", () => {
    const dd = computeMaxDrawdownPct([5, -10, 20], 0);
    expect(Number.isFinite(dd)).toBe(true);
    expect(dd).toBeGreaterThan(0);
  });
});

describe("applyRiskBaselineFilter", () => {
  it("leaves the query untouched when no reset has occurred (null)", () => {
    const q = recordingQuery();
    const result = applyRiskBaselineFilter(q, null);
    expect(result.calls).toEqual([]);
  });

  it("leaves the query untouched when no reset has occurred (undefined)", () => {
    const q = recordingQuery();
    const result = applyRiskBaselineFilter(q, undefined);
    expect(result.calls).toEqual([]);
  });

  it("adds a settled_at floor when a reset timestamp is set", () => {
    const q = recordingQuery();
    const result = applyRiskBaselineFilter(q, "2026-08-06T22:00:00.000Z");
    expect(result.calls).toEqual([
      { op: "gte", args: ["settled_at", "2026-08-06T22:00:00.000Z"] },
    ]);
  });
});
