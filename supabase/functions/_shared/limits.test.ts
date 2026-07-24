import { describe, it, expect } from "vitest";
import {
  computeEffectiveLimits,
  normalizeRiskRow,
  DEFAULT_MAX_DAILY_TRADES,
} from "./limits-math";
import { TIER_DEFINITIONS } from "./billing";
import { DEFAULT_RISK_SETTINGS } from "./risk";

const STARTER = TIER_DEFINITIONS.starter.limits; // maxPositionUsd 100, maxOpenPositions 8, maxTradesPerDay 25
const PRO = TIER_DEFINITIONS.pro.limits;         // maxPositionUsd 500, maxOpenPositions 25, maxTradesPerDay 100
const FREE = TIER_DEFINITIONS.free.limits;       // maxPositionUsd 25,  maxOpenPositions 3,  maxTradesPerDay 5

// A user whose own limits sit BELOW the tier ceiling.
const conservativeRow = {
  max_position_size: 50, max_open_positions: 3, max_daily_trades: 10,
  max_daily_loss: 50, max_drawdown_pct: 15, allocated_capital: 400,
  auto_stop_loss: true, stop_loss_pct: 12,
};
// A user whose own limits sit ABOVE the tier ceiling.
const aggressiveRow = {
  max_position_size: 5000, max_open_positions: 100, max_daily_trades: 1000,
  max_daily_loss: 2000, max_drawdown_pct: 40, allocated_capital: 20000,
  auto_stop_loss: false, stop_loss_pct: 0,
};

describe("computeEffectiveLimits — live mode clamps user to tier (min)", () => {
  it("user below tier → user's own (lower) limits win", () => {
    const e = computeEffectiveLimits(conservativeRow, STARTER, "live");
    expect(e.maxPositionUsd).toBe(50);   // min(50, 100)
    expect(e.maxOpenPositions).toBe(3);  // min(3, 8)
    expect(e.maxDailyTrades).toBe(10);   // min(10, 25)
    expect(e.configured).toBe(true);
    expect(e.allocatedCapital).toBe(400);
  });

  it("user above tier → tier ceiling caps them", () => {
    const e = computeEffectiveLimits(aggressiveRow, STARTER, "live");
    expect(e.maxPositionUsd).toBe(100);  // min(5000, 100)
    expect(e.maxOpenPositions).toBe(8);  // min(100, 8)
    expect(e.maxDailyTrades).toBe(25);   // min(1000, 25)
  });
});

describe("computeEffectiveLimits — paper mode ignores tier position/open caps", () => {
  it("position + open caps are the user's own, unclamped by tier", () => {
    const e = computeEffectiveLimits(aggressiveRow, FREE, "paper");
    expect(e.maxPositionUsd).toBe(5000);   // user as-is (tier NOT applied in paper)
    expect(e.maxOpenPositions).toBe(100);  // user as-is
  });

  it("but the daily-trade cap is min(user, tier) in BOTH modes", () => {
    const e = computeEffectiveLimits(aggressiveRow, FREE, "paper");
    expect(e.maxDailyTrades).toBe(5);      // min(1000, free tier 5)
  });
});

describe("computeEffectiveLimits — unconfigured (no risk row)", () => {
  it("falls back to DEFAULT_RISK_SETTINGS and marks configured=false", () => {
    const e = computeEffectiveLimits(null, FREE, "live");
    expect(e.configured).toBe(false);
    // defaults: max_position_size 20, max_open_positions 3, allocated 1000; daily default 30
    expect(e.maxPositionUsd).toBe(Math.min(DEFAULT_RISK_SETTINGS.max_position_size, FREE.maxPositionUsd)); // min(20,25)=20
    expect(e.maxOpenPositions).toBe(Math.min(DEFAULT_RISK_SETTINGS.max_open_positions, FREE.maxOpenPositions)); // min(3,3)=3
    expect(e.maxDailyTrades).toBe(Math.min(DEFAULT_MAX_DAILY_TRADES, FREE.maxTradesPerDay)); // min(30,5)=5
    expect(e.allocatedCapital).toBe(DEFAULT_RISK_SETTINGS.allocated_capital);
  });
});

describe("computeEffectiveLimits — daily-trade unification", () => {
  it("takes the stricter of user vs tier regardless of which is lower", () => {
    // user 10 < pro tier 100 → 10
    expect(computeEffectiveLimits({ ...conservativeRow }, PRO, "live").maxDailyTrades).toBe(10);
    // user 1000 > pro tier 100 → 100
    expect(computeEffectiveLimits({ ...aggressiveRow }, PRO, "live").maxDailyTrades).toBe(100);
  });

  it("uses the default cap when the row omits max_daily_trades", () => {
    const rowNoDaily = { ...conservativeRow } as Record<string, unknown>;
    delete rowNoDaily.max_daily_trades;
    // min(DEFAULT_MAX_DAILY_TRADES 30, pro 100) = 30
    expect(computeEffectiveLimits(rowNoDaily, PRO, "live").maxDailyTrades).toBe(30);
  });
});

describe("normalizeRiskRow", () => {
  it("null → a copy of DEFAULT_RISK_SETTINGS", () => {
    expect(normalizeRiskRow(null)).toEqual(DEFAULT_RISK_SETTINGS);
  });

  it("fills missing fields from defaults and coerces strings to numbers", () => {
    // Supabase numeric columns arrive as strings over the wire.
    const rs = normalizeRiskRow({ max_position_size: "250", allocated_capital: "1500" });
    expect(rs.max_position_size).toBe(250);
    expect(rs.allocated_capital).toBe(1500);
    expect(rs.max_open_positions).toBe(DEFAULT_RISK_SETTINGS.max_open_positions); // filled from default
  });
});
