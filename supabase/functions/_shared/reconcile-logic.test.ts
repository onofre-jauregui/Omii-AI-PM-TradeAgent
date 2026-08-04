import { describe, it, expect } from "vitest";
import { decideReconcile, contractCount, pickAvgPrice, decidePaperReconcile } from "./reconcile-logic";

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

describe("decidePaperReconcile", () => {
  // marketGone comes from the MARKET endpoint's 404/410, not the orderbook's —
  // Kalshi serves a 200 empty book for tickers that never existed, so the old
  // orderbook-sourced flag could never fire.
  it("cancels when Kalshi has no such market, regardless of fill state", () => {
    expect(decidePaperReconcile(true, 0, 10)).toBe("cancel");
    expect(decidePaperReconcile(true, 10, 10)).toBe("cancel");
  });

  it("fills when the full requested size is now covered", () => {
    expect(decidePaperReconcile(false, 10, 10)).toBe("fill");
    expect(decidePaperReconcile(false, 12, 10)).toBe("fill"); // over-covered still counts as filled
  });

  it("marks partial when some but not all is covered", () => {
    expect(decidePaperReconcile(false, 4, 10)).toBe("partial");
  });

  it("does nothing when nothing is covered yet", () => {
    expect(decidePaperReconcile(false, 0, 10)).toBe("none");
  });

  it("does nothing when requested size is unknown (0)", () => {
    expect(decidePaperReconcile(false, 0, 0)).toBe("none");
  });

  it("is idempotent — repeated calls with the same inputs return the same decision", () => {
    const first = decidePaperReconcile(false, 4, 10);
    const second = decidePaperReconcile(false, 4, 10);
    expect(first).toBe(second);
  });

  // Regression: 39 paper orders ($855) sat "open" for up to 8 days because a
  // resolved market keeps answering its orderbook endpoint with HTTP 200 and an
  // empty book. tickerGone stays false, nothing fills, and the old signature had
  // no way to express "this can never fill" — so the cron re-checked all 39 every
  // 5 minutes forever and their outcomes never entered the track record.
  it("cancels an unfilled order once its market is finalized or settled", () => {
    expect(decidePaperReconcile(false, 0, 10, "finalized")).toBe("cancel");
    expect(decidePaperReconcile(false, 0, 10, "settled")).toBe("cancel");
    expect(decidePaperReconcile(false, 0, 10, "FINALIZED")).toBe("cancel");
  });

  it("still fills ahead of cancelling when the book covers the order", () => {
    // Order of evaluation matters: a real fill must win over the terminal-market
    // branch, or a settle landing mid-run would discard a legitimate fill.
    expect(decidePaperReconcile(false, 10, 10, "finalized")).toBe("fill");
    expect(decidePaperReconcile(false, 4, 10, "settled")).toBe("partial");
  });

  it("leaves the order resting while its market can still trade", () => {
    expect(decidePaperReconcile(false, 0, 10, "active")).toBe("none");
    // 'closed' is deliberately NOT terminal — the market has stopped trading but
    // has not resolved, and Kalshi settles shortly after close.
    expect(decidePaperReconcile(false, 0, 10, "closed")).toBe("none");
  });

  it("treats an unknown market status as no reason to act", () => {
    // A flaky or failed status lookup must never terminate an order.
    expect(decidePaperReconcile(false, 0, 10, undefined)).toBe("none");
    expect(decidePaperReconcile(false, 0, 10, "")).toBe("none");
  });
});
