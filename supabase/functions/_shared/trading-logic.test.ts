import { describe, it, expect } from "vitest";
import { computePnl } from "./trading-logic";

describe("computePnl", () => {
  it("computes gross pnl on a win, net_pnl equal to gross when no fee is passed (backward compatible)", () => {
    // buy yes @ 50c, $50 -> 100 contracts, result yes -> win: 100*(1-0.5)=50
    const { pnl, netPnl, outcome } = computePnl("yes", "buy", 50, 50, "yes");
    expect(outcome).toBe("win");
    expect(pnl).toBe(50);
    expect(netPnl).toBe(50);
  });

  it("computes gross pnl on a loss, net_pnl equal to gross when no fee is passed", () => {
    const { pnl, netPnl, outcome } = computePnl("yes", "buy", 50, 50, "no");
    expect(outcome).toBe("loss");
    expect(pnl).toBe(-50);
    expect(netPnl).toBe(-50);
  });

  it("subtracts the fee from net_pnl on a win, leaving gross pnl untouched", () => {
    const { pnl, netPnl, outcome } = computePnl("yes", "buy", 50, 50, "yes", 200); // 200c = $2 fee
    expect(outcome).toBe("win");
    expect(pnl).toBe(50); // gross unchanged
    expect(netPnl).toBeCloseTo(48, 5); // 50 - 2
  });

  it("subtracts the fee from net_pnl on a loss too, leaving gross pnl untouched", () => {
    const { pnl, netPnl } = computePnl("yes", "buy", 50, 50, "no", 200);
    expect(pnl).toBe(-50);
    expect(netPnl).toBeCloseTo(-52, 5); // -50 - 2
  });

  it("void result (unresolved) has zero pnl and net_pnl regardless of fee", () => {
    const { pnl, netPnl, outcome } = computePnl("yes", "buy", 50, 50, "void", 200);
    expect(outcome).toBe("void");
    expect(pnl).toBe(0);
    expect(netPnl).toBe(0);
  });

  it("non-buy actions are void with zero pnl/net_pnl", () => {
    const { pnl, netPnl, outcome } = computePnl("yes", "sell", 50, 50, "yes", 200);
    expect(outcome).toBe("void");
    expect(pnl).toBe(0);
    expect(netPnl).toBe(0);
  });
});
