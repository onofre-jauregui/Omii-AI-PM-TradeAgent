import { describe, it, expect } from "vitest";
import { decideReconcile, contractCount, pickAvgPrice } from "./reconcile-logic";

describe("decideReconcile", () => {
  it("fills when remaining_count is 0", () => {
    // initialCount 10, fully filled
    expect(decideReconcile("executed", 0, 10)).toBe("fill");
    expect(decideReconcile("resting", 0, 10)).toBe("fill");
  });

  it("cancels on terminal Kalshi statuses (canceled/cancelled/expired)", () => {
    expect(decideReconcile("canceled", 10, 10)).toBe("cancel");
    expect(decideReconcile("cancelled", 5, 10)).toBe("cancel");
    expect(decideReconcile("expired", 10, 10)).toBe("cancel");
    // Case-insensitive
    expect(decideReconcile("CANCELED", 10, 10)).toBe("cancel");
  });

  it("marks partial when some but not all contracts remain", () => {
    expect(decideReconcile("resting", 4, 10)).toBe("partial");
  });

  it("does nothing when fully resting (remaining === initial)", () => {
    expect(decideReconcile("resting", 10, 10)).toBe("none");
  });

  it("does nothing when initial count is unknown (0) and order is not filled/cancelled", () => {
    expect(decideReconcile("resting", 5, 0)).toBe("none");
  });

  it("cancel takes precedence even if remaining is 0", () => {
    // A canceled order with 0 remaining should not be treated as a fill.
    expect(decideReconcile("canceled", 0, 10)).toBe("cancel");
  });
});

describe("contractCount", () => {
  it("computes floor(amount / (price/100))", () => {
    // $100 at 50¢ → $100 / $0.50 = 200 contracts
    expect(contractCount(100, 50)).toBe(200);
    // $100 at 99¢ → 101.01 → floor 101
    expect(contractCount(100, 99)).toBe(101);
  });

  it("returns 0 for missing inputs", () => {
    expect(contractCount(null, 50)).toBe(0);
    expect(contractCount(100, null)).toBe(0);
    expect(contractCount(0, 50)).toBe(0);
  });
});

describe("pickAvgPrice", () => {
  it("reads avg_price when present", () => {
    expect(pickAvgPrice({ avg_price: 47 })).toBe(47);
  });

  it("tolerates field-name variants", () => {
    expect(pickAvgPrice({ average_fill_price: 47 })).toBe(47);
    expect(pickAvgPrice({ avg_fill_price: 47 })).toBe(47);
  });

  it("returns null when no price field is present or numeric", () => {
    expect(pickAvgPrice({})).toBe(null);
    expect(pickAvgPrice({ avg_price: "47" })).toBe(null);
    expect(pickAvgPrice(null)).toBe(null);
  });
});
