/**
 * Guards the UI pricing table against drifting away from server enforcement.
 *
 * Before this existed, the landing page advertised "no position size limits" on
 * Free and "no position size cap" on Starter while the server enforced $25 and
 * $100 caps, and the landing page omitted the $999 Prop tier entirely. Any future
 * edit to a price or a limit in one place and not the other fails here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  PRICING_TIERS,
  tierFeatures,
  tierPriceLabel,
  tierLabel,
  FREE_TIER,
  LIVE_STRATEGIES,
} from "./pricing";
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

  it("advertises exactly the number of strategies the tier can actually run", () => {
    for (const tier of PRICING_TIERS) {
      const runnable = TIER_DEFINITIONS[tier.id].limits.allowedStrategies.filter((s) =>
        LIVE_STRATEGIES.includes(s)
      );
      expect(tier.strategyCount, `${tier.id} strategy count`).toBe(runnable.length);
    }
  });

  it("entitles no strategy auto-trade cannot run", () => {
    // S-004 was entitled here while having no handler in auto-trade, so both
    // pricing surfaces sold a strategy that was impossible to run. Re-adding an
    // unimplemented strategy to allowedStrategies fails here.
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      for (const id of tier.limits.allowedStrategies) {
        expect(LIVE_STRATEGIES, `${tier.tier} entitles ${id}`).toContain(id);
      }
    }
  });

  it("keeps strategy identifiers out of customer-facing copy", () => {
    for (const tier of PRICING_TIERS) {
      const copy = [tier.name, tier.description, ...tierFeatures(tier)].join(" ");
      expect(namedStrategies(copy), `${tier.id} names internal strategy IDs`).toEqual([]);
    }
  });

  it("gives Pro more strategies than Starter", () => {
    const count = (id: string) => PRICING_TIERS.find((t) => t.id === id)!.strategyCount;
    expect(count("pro")).toBeGreaterThan(count("starter"));
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

  it("labels every server tier with its display name", () => {
    for (const id of Object.keys(TIER_DEFINITIONS) as Tier[]) {
      expect(tierLabel(id)).toBe(TIER_DEFINITIONS[id].displayName);
    }
  });

  it("passes an unknown tier through rather than rendering blank", () => {
    expect(tierLabel("enterprise")).toBe("enterprise");
  });
});

/**
 * Paid access is closed. The browser constant alone is not a gate — anyone can
 * POST to the edge function directly — so the two must move together, and the
 * server side has to stay shut on its own.
 */
describe("closed-billing gate", () => {
  const repoFile = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  const checkoutSource = repoFile("supabase/functions/create-checkout/index.ts");

  it("keeps create-checkout closed unless BILLING_ENABLED is explicitly true", () => {
    expect(checkoutSource).toContain('Deno.env.get("BILLING_ENABLED") !== "true"');
  });

  it("refuses before spending anything — the gate precedes auth and Stripe calls", () => {
    const gateAt = checkoutSource.indexOf('Deno.env.get("BILLING_ENABLED")');
    const authAt = checkoutSource.indexOf("anonClient.auth.getUser()");
    const stripeAt = checkoutSource.indexOf("api.stripe.com");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(authAt);
    expect(gateAt).toBeLessThan(stripeAt);
  });

  it("routes the billing page CTA to the waitlist, with checkout as the gated branch", () => {
    const billingPage = repoFile("src/pages/BillingPage.tsx");
    // Checkout is the TRUE branch of `BILLING_LIVE ? … : …` and the waitlist join
    // is the FALSE branch, so the closed state is what a user actually gets.
    // Inverting the ternary — or dropping the gate — reorders these three.
    const gate = billingPage.indexOf("BILLING_LIVE ? (");
    const upgrade = billingPage.indexOf("handleUpgrade(plan.id)");
    const waitlist = billingPage.indexOf("handleJoinWaitlist(plan.id)");
    expect(gate, "BILLING_LIVE ternary around the plan CTA").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(upgrade);
    expect(upgrade).toBeLessThan(waitlist);
  });

  it("keeps the Stripe payment footer behind the same flag", () => {
    const billingPage = repoFile("src/pages/BillingPage.tsx");
    const footer = billingPage.indexOf("Payments are processed by Stripe");
    expect(footer, "Stripe footer copy").toBeGreaterThan(-1);
    // Telling a user their payment is processed by Stripe on a page that cannot
    // take a payment is the exact mismatch this whole flag exists to prevent.
    expect(footer - billingPage.lastIndexOf("BILLING_LIVE", footer)).toBeLessThan(120);
  });
});
