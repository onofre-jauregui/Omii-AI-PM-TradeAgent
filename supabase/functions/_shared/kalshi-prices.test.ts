import { describe, it, expect } from "vitest";
import { kalshiPriceToCents, marketFieldCents } from "./kalshi-prices.ts";

describe("kalshiPriceToCents", () => {
  it("prefers the integer-cents field when both are present", () => {
    expect(kalshiPriceToCents(45, "0.45")).toBe(45);
    expect(kalshiPriceToCents(45, "0.99")).toBe(45); // cents wins even on disagreement
  });

  // The magnitude-guessing bug this module exists to kill: `v > 1 ? v : v*100`
  // read a literal 1¢ as 100¢. Explicit fields make 1¢ unambiguous.
  it("handles a 1¢ price without magnitude guessing", () => {
    expect(kalshiPriceToCents(1, undefined)).toBe(1);
    expect(kalshiPriceToCents(undefined, "0.01")).toBe(1);
    expect(kalshiPriceToCents(1, "0.01")).toBe(1);
  });

  it("falls back to dollars×100 only when cents is absent", () => {
    expect(kalshiPriceToCents(undefined, "0.45")).toBe(45);
    expect(kalshiPriceToCents(null, 0.45)).toBe(45);
    expect(kalshiPriceToCents(undefined, "0.995")).toBe(100); // rounds
  });

  it("returns null when neither field exists — callers must handle, not default", () => {
    expect(kalshiPriceToCents(undefined, undefined)).toBeNull();
    expect(kalshiPriceToCents(null, null)).toBeNull();
    expect(kalshiPriceToCents("", "")).toBeNull();
    expect(kalshiPriceToCents("garbage", "junk")).toBeNull();
  });

  it("accepts string cents (JSONB round-trips numbers as strings sometimes)", () => {
    expect(kalshiPriceToCents("45", undefined)).toBe(45);
  });

  it("zero cents is a real price, not a missing value", () => {
    expect(kalshiPriceToCents(0, "0.45")).toBe(0);
  });
});

describe("marketFieldCents", () => {
  it("reads the field/field_dollars pair off a market object", () => {
    expect(marketFieldCents({ yes_ask: 45, yes_ask_dollars: "0.45" }, "yes_ask")).toBe(45);
    expect(marketFieldCents({ yes_ask_dollars: "0.45" }, "yes_ask")).toBe(45);
    expect(marketFieldCents({ yes_ask: 1 }, "yes_ask")).toBe(1);
  });

  it("null-safe on missing market or field", () => {
    expect(marketFieldCents(null, "yes_ask")).toBeNull();
    expect(marketFieldCents({}, "yes_ask")).toBeNull();
  });
});
