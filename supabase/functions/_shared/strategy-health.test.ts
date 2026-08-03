import { describe, it, expect } from "vitest";
import { computeMaxDrawdownPct } from "./strategy-health";

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
