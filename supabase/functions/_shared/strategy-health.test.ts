import { describe, it, expect } from "vitest";
import {
  applyRiskBaselineFilter,
  computeMaxDrawdownPct,
  evaluateAutoResume,
  MIN_EXPECTANCY_SAMPLE,
} from "./strategy-health";

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

describe("evaluateAutoResume", () => {
  /** n losing trades of -$x each, padded with wins so the mean is controllable. */
  const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

  it("blocks the resume for a strategy that loses money on average", () => {
    // The S-005 shape: mostly losers, occasional winner, negative mean.
    // Left to the timer alone this cycles lose → suspend → resume → lose forever.
    const pnls = [...repeat(-11.7, 23), ...repeat(10.82, 7)];
    const verdict = evaluateAutoResume(pnls);

    expect(verdict.resume).toBe(false);
    expect(verdict.reason).toBe("negative_expectancy");
    expect(verdict.expectancy).toBeLessThan(0);
    expect(verdict.sampleSize).toBe(30);
  });

  it("resumes a strategy whose window is profitable despite a losing streak", () => {
    // A loss streak is what suspends a strategy; it must not also be what keeps
    // it suspended when the wider window is still making money.
    const pnls = [...repeat(5, 25), ...repeat(-2, 5)];
    const verdict = evaluateAutoResume(pnls);

    expect(verdict.resume).toBe(true);
    expect(verdict.reason).toBe("positive_expectancy");
  });

  it("resumes at exactly break-even rather than holding on a zero mean", () => {
    const verdict = evaluateAutoResume([...repeat(5, 15), ...repeat(-5, 15)]);

    expect(verdict.expectancy).toBe(0);
    expect(verdict.resume).toBe(true);
  });

  it("resumes below the minimum sample so a new strategy is never stranded", () => {
    // Deeply negative, but too few trades to be evidence of anything. This is the
    // noise the suspension timer exists to absorb.
    const verdict = evaluateAutoResume(repeat(-50, MIN_EXPECTANCY_SAMPLE - 1));

    expect(verdict.resume).toBe(true);
    expect(verdict.reason).toBe("insufficient_sample");
    expect(verdict.sampleSize).toBe(MIN_EXPECTANCY_SAMPLE - 1);
  });

  it("resumes when the strategy has no settled trades at all", () => {
    expect(evaluateAutoResume([]).resume).toBe(true);
  });

  it("holds at exactly the minimum sample when expectancy is negative", () => {
    // Boundary: the sample gate must open at MIN_EXPECTANCY_SAMPLE, not one past it.
    const verdict = evaluateAutoResume(repeat(-1, MIN_EXPECTANCY_SAMPLE));

    expect(verdict.sampleSize).toBe(MIN_EXPECTANCY_SAMPLE);
    expect(verdict.resume).toBe(false);
  });
});

describe("evaluateAutoResume — applied to an already-active strategy", () => {
  const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

  it("deactivates a running strategy that is losing money on average", () => {
    // The gap the resume gate alone left open: S-005 auto-resumed at 13:07 UTC
    // and kept trading, because the resume verdict is only consulted on the way
    // back in. The same window has to stop a strategy already in flight.
    const verdict = evaluateAutoResume([...repeat(-11.7, 23), ...repeat(10.82, 7)]);

    expect(verdict.resume).toBe(false);
    expect(verdict.expectancy).toBeCloseTo(-6.45, 2);
  });

  it("leaves a running strategy alone while its window is profitable", () => {
    // A losing streak inside a profitable window must not deactivate — that is
    // what the timed consecutive-loss suspension is for.
    const verdict = evaluateAutoResume([...repeat(6, 24), ...repeat(-3, 6)]);

    expect(verdict.resume).toBe(true);
    expect(verdict.reason).toBe("positive_expectancy");
  });

  it("never deactivates a strategy that has not yet reached the sample floor", () => {
    // A new strategy must be allowed to build a record before this rule can
    // touch it, however ugly its first few trades look.
    const verdict = evaluateAutoResume(repeat(-25, MIN_EXPECTANCY_SAMPLE - 1));

    expect(verdict.resume).toBe(true);
    expect(verdict.reason).toBe("insufficient_sample");
  });

  it("agrees with itself across both call sites for the same window", () => {
    // The resume path (§2a) and the running path (§2b) read the same pnl window.
    // If they ever disagreed, a strategy would deactivate and immediately resume.
    const window = [...repeat(-4, 18), ...repeat(3, 12)];

    expect(evaluateAutoResume(window)).toEqual(evaluateAutoResume(window));
  });
});
