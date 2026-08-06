import { describe, expect, it } from "vitest";
import {
  allocateSettlement,
  type KalshiSettlement,
  normalizeResolution,
  type ReconcilableTrade,
} from "./ledger-reconcile.ts";

/** The real 2026-08-03 settlement, verbatim from Kalshi's API. */
const REAL_SETTLEMENT: KalshiSettlement = {
  ticker: "KXINX-26AUG03H1600-B7512",
  market_result: "no",
  revenue: 1600,
  no_total_cost_dollars: "12.800000",
  yes_total_cost_dollars: "0.000000",
  fee_cost: "0.000000",
  settled_time: "2026-08-03T23:01:50.942796Z",
};

const trade = (id: string, amount: number, pnl?: number, net?: number): ReconcilableTrade => ({
  id,
  ticker: REAL_SETTLEMENT.ticker,
  amount,
  pnl: pnl ?? null,
  net_pnl: net ?? null,
});

describe("normalizeResolution", () => {
  it("passes yes/no through and folds every void spelling to 'void'", () => {
    expect(normalizeResolution("no")).toBe("no");
    expect(normalizeResolution("YES")).toBe("yes");
    for (const v of ["void", "voided", "cancelled", "canceled"]) {
      expect(normalizeResolution(v)).toBe("void");
    }
    // The trades CHECK allows only yes/no/void — anything else must be NULL, not
    // a passthrough that fails the constraint mid-reconcile.
    expect(normalizeResolution("closed")).toBeNull();
    expect(normalizeResolution("")).toBeNull();
  });
});

describe("allocateSettlement", () => {
  it("prices a single trade straight from Kalshi's revenue and cost", () => {
    const [row] = allocateSettlement(REAL_SETTLEMENT, [trade("a", 13)]);
    expect(row.pnl).toBe(3.2); // $16.00 revenue − $12.80 cost
    expect(row.net_pnl).toBe(3.2); // no fee on this settlement
    expect(row.resolution).toBe("no");
    expect(row.settled_at).toBe("2026-08-03T23:01:50.942796Z");
  });

  it("subtracts the real fee rather than an estimate", () => {
    const withFee = { ...REAL_SETTLEMENT, fee_cost: "0.175000" };
    const [row] = allocateSettlement(withFee, [trade("a", 13)]);
    expect(row.pnl).toBe(3.2);
    expect(row.net_pnl).toBe(3.03);
    expect(row.fee_cents).toBe(18);
  });

  it("never produces net_pnl greater than gross — the 2026-07-27 corruption", () => {
    const withFee = { ...REAL_SETTLEMENT, fee_cost: "0.175000" };
    for (const rows of [[trade("a", 13)], [trade("a", 10), trade("b", 10)]]) {
      for (const r of allocateSettlement(withFee, rows)) {
        expect(r.net_pnl).toBeLessThanOrEqual(r.pnl);
      }
    }
  });

  it("fans one settlement across the many orders that formed the position", () => {
    // Eight $10 orders on B7437 aggregated into one 96-contract Kalshi position,
    // settled once for $96.00 revenue against $76.80 cost.
    const s: KalshiSettlement = {
      ...REAL_SETTLEMENT,
      ticker: "KXINX-26JUL27H1600-B7437",
      revenue: 9600,
      no_total_cost_dollars: "76.800000",
      fee_cost: "1.400000",
    };
    const rows = allocateSettlement(s, Array.from({ length: 8 }, (_, i) => trade(`t${i}`, 10)));
    expect(rows).toHaveLength(8);
    // The group must tie to Kalshi exactly, to the cent.
    const gross = rows.reduce((a, r) => a + r.pnl, 0);
    const net = rows.reduce((a, r) => a + r.net_pnl, 0);
    expect(Number(gross.toFixed(2))).toBe(19.2); // 96.00 − 76.80
    expect(Number(net.toFixed(2))).toBe(17.8); // − 1.40 fee
  });

  it("allocates pro rata by cost basis when legs are unequal", () => {
    const s = { ...REAL_SETTLEMENT, revenue: 3000, no_total_cost_dollars: "24.000000" };
    const rows = allocateSettlement(s, [trade("big", 18), trade("small", 6)]);
    expect(Number((rows[0].pnl / rows[1].pnl).toFixed(2))).toBe(3); // 18:6
    expect(Number((rows[0].pnl + rows[1].pnl).toFixed(2))).toBe(6); // 30.00 − 24.00
  });

  it("splits equally rather than dropping the settlement when amounts are missing", () => {
    const rows = allocateSettlement(REAL_SETTLEMENT, [trade("a", 0), trade("b", 0)]);
    expect(Number((rows[0].pnl + rows[1].pnl).toFixed(2))).toBe(3.2);
    expect(rows[0].pnl).toBe(rows[1].pnl);
  });

  it("flags a row unchanged when it already matches, so re-running is a no-op", () => {
    const [already] = allocateSettlement(REAL_SETTLEMENT, [trade("a", 13, 3.2, 3.2)]);
    expect(already.changed).toBe(false);
    const [stale] = allocateSettlement(REAL_SETTLEMENT, [trade("a", 13, 2.4, 2.5)]);
    expect(stale.changed).toBe(true);
  });

  it("returns nothing when no local trade matches the settlement", () => {
    expect(allocateSettlement(REAL_SETTLEMENT, [])).toEqual([]);
  });
});
