/**
 * Guards the UI pricing table against drifting away from server enforcement.
 *
 * Before this existed, the landing page advertised "no position size limits" on
 * Free and "no position size cap" on Starter while the server enforced $25 and
 * $100 caps, and the landing page omitted the $999 Prop tier entirely. Any future
 * edit to a price or a limit in one place and not the other fails here.
 */
import { describe, it, expect } from "vitest";
import { PRICING_TIERS, tierFeatures, tierPriceLabel, FREE_TIER, LIVE_STRATEGIES } from "./pricing";
import { TIER_DEFINITIONS, type Tier } from "../../supabase/functions/_shared/billing";

/** Strategy IDs a piece of pricing copy claims the plan includes. */
const namedStrategies = (label: string): string[] => label.match(/S-\d{3}/g) ?? [];

describe("UI pricing table vs server tier definitions", () => {
  it("covers every server tier, and no others", () => {
    expect(PRICING_TIERS.map((t) => t.id).sort()).toEqual(
      (Object.keys(TIER_DEFINITIONS) as Tier[]).sort()
    );
  });

  it.each(PRICING_TIERS)("$id matches the enforced price and limits", (tier) => {
    const server = TIER_DEFINITIONS[tier.id];
    expect(tier.monthlyPriceUsd).toBe(server.monthlyPriceUsd);
    expect(tier.maxTradesPerDay).toBe(server.limits.maxTradesPerDay);
    expect(tier.maxOpenPositions).toBe(server.limits.maxOpenPositions);
    expect(tier.maxPositionUsd).toBe(server.limits.maxPositionUsd);
    expect(tier.liveTradingEnabled).toBe(server.limits.liveTradingEnabled);
  });

  it("never advertises a strategy the tier is not entitled to", () => {
    for (const tier of PRICING_TIERS) {
      const allowed = TIER_DEFINITIONS[tier.id].limits.allowedStrategies;
      for (const id of namedStrategies(tier.strategiesLabel)) {
        expect(allowed, `${tier.id} advertises ${id}`).toContain(id);
      }
    }
  });

  it("never advertises a strategy that has no execution path", () => {
    // S-004 is entitled server-side but unimplemented in auto-trade — selling it
    // would be a placeholder claim. This fails the moment copy names it again.
    for (const tier of PRICING_TIERS) {
      for (const id of namedStrategies(tier.strategiesLabel)) {
        expect(Object.keys(LIVE_STRATEGIES), `${tier.id} advertises ${id}`).toContain(id);
      }
    }
  });

  it("gives Pro a strategy Starter does not have", () => {
    const starter = PRICING_TIERS.find((t) => t.id === "starter")!;
    const pro = PRICING_TIERS.find((t) => t.id === "pro")!;
    const starterAllowed = TIER_DEFINITIONS[starter.id].limits.allowedStrategies;
    const proAllowed = TIER_DEFINITIONS[pro.id].limits.allowedStrategies;
    const upgrade = proAllowed.filter((s) => !starterAllowed.includes(s) && s in LIVE_STRATEGIES);
    expect(upgrade.length).toBeGreaterThan(0);
    for (const id of upgrade) expect(pro.strategiesLabel).toContain(id);
  });

  it("advertises no capability the free tier does not have", () => {
    expect(FREE_TIER.liveTradingEnabled).toBe(false);
    const text = tierFeatures(FREE_TIER).join(" ").toLowerCase();
    expect(text).not.toMatch(/no (position size )?limits?/);
    expect(text).not.toMatch(/no .*cap\b/);
    expect(text).toContain("paper trading only");
  });

  it("advertises no unlimited position size on any tier", () => {
    for (const tier of PRICING_TIERS) {
      const text = tierFeatures(tier).join(" ").toLowerCase();
      expect(text).not.toMatch(/unlimited|no position size/);
    }
  });

  it("badges exactly one tier as most popular", () => {
    expect(PRICING_TIERS.filter((t) => t.highlight)).toHaveLength(1);
  });

  it("renders limit bullets from the enforced numbers", () => {
    const pro = PRICING_TIERS.find((t) => t.id === "pro")!;
    expect(tierFeatures(pro)).toEqual(
      expect.arrayContaining(["100 trades / day", "25 open positions", "$500 max position"])
    );
    expect(tierPriceLabel(pro)).toBe("$199");
    const prop = PRICING_TIERS.find((t) => t.id === "prop")!;
    expect(tierFeatures(prop)).toEqual(
      expect.arrayContaining(["1,000 trades / day", "$5,000 max position"])
    );
  });
});
