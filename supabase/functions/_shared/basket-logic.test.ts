import { describe, it, expect } from "vitest";
import { determineBasketStatus, resolveFlattenOutcome, didLegFill } from "./basket-logic.ts";

describe("didLegFill", () => {
  // Regression lock for a 2026-07-31 finding: execute-trade returns
  // success:true even for a fully unfilled "open" resting order (e.g. no
  // real liquidity, or a nonexistent ticker — DESIGN-REPORT.md §6). A basket
  // leg's success flag alone can't tell "this leg holds a real position"
  // from "this leg is an inert resting order with nothing behind it."

  it("returns true for a filled leg", () => {
    expect(didLegFill({ success: true, trade: { status: "filled" } })).toBe(true);
  });

  it("returns true for a partially filled leg", () => {
    expect(didLegFill({ success: true, trade: { status: "partial" } })).toBe(true);
  });

  it("returns false for success:true with an unfilled 'open' status — the core regression", () => {
    expect(didLegFill({ success: true, trade: { status: "open" } })).toBe(false);
  });

  it("returns false for a failed leg", () => {
    expect(didLegFill({ success: false, trade: { status: "failed" } })).toBe(false);
  });

  it("returns false when there's no trade object at all", () => {
    expect(didLegFill({ success: true })).toBe(false);
  });
});

describe("determineBasketStatus", () => {
  it("returns completed when every leg actually filled", () => {
    const legs = [{ success: true, trade: { status: "filled" } }, { success: true, trade: { status: "filled" } }];
    expect(determineBasketStatus(legs, 2, 2, null)).toBe("completed");
  });

  it("does NOT return completed when a leg returned success:true but never filled (the core regression)", () => {
    const legs = [{ success: true, trade: { status: "filled" } }, { success: true, trade: { status: "open" } }];
    // filledLegCount reflects only the one leg that actually filled — the caller
    // is responsible for not counting the "open" leg toward it (see execute-basket's
    // didLegFill-gated filledTradeIds.push).
    expect(determineBasketStatus(legs, 2, 1, "Leg 2 did not fill (status: open)")).toBe("partially_filled");
  });

  it("returns partially_filled when some legs filled and an abort reason exists", () => {
    const legs = [{ success: true, trade: { status: "filled" } }, { success: false }];
    expect(determineBasketStatus(legs, 2, 1, "Leg 2 failed: rejected")).toBe("partially_filled");
  });

  it("returns timed_out when the abort reason mentions timeout and nothing filled", () => {
    const legs: { success: boolean }[] = [];
    expect(determineBasketStatus(legs, 2, 0, "Basket timed out after 30s")).toBe("timed_out");
  });

  it("returns aborted for a non-timeout abort with nothing filled", () => {
    const legs = [{ success: false }];
    expect(determineBasketStatus(legs, 2, 0, "Leg 1 failed: execution error")).toBe("aborted");
  });

  it("returns aborted when there's no abort reason but legs are still incomplete", () => {
    const legs = [{ success: true, trade: { status: "filled" } }];
    expect(determineBasketStatus(legs, 2, 1, null)).toBe("aborted");
  });
});

describe("resolveFlattenOutcome", () => {
  // Regression lock for the 2026-07-30 production-readiness audit finding:
  // execute-basket set finalStatus="flattened" whenever flattenResults was
  // merely non-empty, including entries for FAILED flatten attempts — a
  // basket left with real naked live exposure could be reported as safely
  // resolved. DESIGN-REPORT.md §6 finding #3.

  it("returns not_attempted when there was nothing to flatten", () => {
    expect(resolveFlattenOutcome([], 0)).toBe("not_attempted");
  });

  it("returns flattened only when every filled leg's flatten succeeded", () => {
    const results = [{ success: true }, { success: true }];
    expect(resolveFlattenOutcome(results, 2)).toBe("flattened");
  });

  it("returns flatten_failed when a flatten attempt fails, even if others succeeded — never silently claims safety", () => {
    const results = [{ success: true }, { success: false }];
    expect(resolveFlattenOutcome(results, 2)).toBe("flatten_failed");
  });

  it("returns flatten_failed when every flatten attempt fails (the exact bug scenario — all entries present, all failed)", () => {
    const results = [{ success: false }, { success: false }];
    expect(resolveFlattenOutcome(results, 2)).toBe("flatten_failed");
  });

  it("returns flatten_failed when fewer flatten attempts succeeded than legs were filled", () => {
    // e.g. only 1 of 2 filled legs got a flatten attempt recorded at all
    const results = [{ success: true }];
    expect(resolveFlattenOutcome(results, 2)).toBe("flatten_failed");
  });
});
