import { describe, it, expect } from "vitest";
import {
  TIER_DEFINITIONS,
  isSubscriptionActive,
  resolveLimits,
  checkEntitlement,
  verifyStripeSignature,
  priceIdToTier,
  type SubscriptionRow,
} from "./billing";

describe("TIER_DEFINITIONS", () => {
  it("has all four tiers", () => {
    const tiers = Object.keys(TIER_DEFINITIONS).sort();
    expect(tiers).toEqual(["free", "pro", "prop", "starter"]);
  });

  it("free tier has paper-only with all strategies available", () => {
    const free = TIER_DEFINITIONS.free;
    expect(free.limits.liveTradingEnabled).toBe(false);
    // Free tier allows all strategies in paper mode — live trading is gated by liveTradingEnabled
    expect(free.limits.allowedStrategies).toEqual(
      expect.arrayContaining(["S-001", "S-002", "S-005"])
    );
  });

  it("pricing is monotonically increasing", () => {
    expect(TIER_DEFINITIONS.free.monthlyPriceUsd).toBe(0);
    expect(TIER_DEFINITIONS.starter.monthlyPriceUsd).toBeLessThan(
      TIER_DEFINITIONS.pro.monthlyPriceUsd
    );
    expect(TIER_DEFINITIONS.pro.monthlyPriceUsd).toBeLessThan(
      TIER_DEFINITIONS.prop.monthlyPriceUsd
    );
  });

  it("position limits increase monotonically with tier and match what's advertised", () => {
    expect(TIER_DEFINITIONS.free.limits.maxPositionUsd).toBe(25);
    expect(TIER_DEFINITIONS.starter.limits.maxPositionUsd).toBe(100);
    expect(TIER_DEFINITIONS.pro.limits.maxPositionUsd).toBe(500);
    expect(TIER_DEFINITIONS.prop.limits.maxPositionUsd).toBe(5000);
  });

  it("S-003 (Economic Consensus) is not in any tier per Fed paper evidence", () => {
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      expect(tier.limits.allowedStrategies).not.toContain("S-003");
    }
  });

  it("S-005 (weather) is available in pro and prop", () => {
    expect(TIER_DEFINITIONS.pro.limits.allowedStrategies).toContain("S-005");
    expect(TIER_DEFINITIONS.prop.limits.allowedStrategies).toContain("S-005");
  });
});

describe("isSubscriptionActive", () => {
  it("returns true for active and trialing", () => {
    expect(isSubscriptionActive("active")).toBe(true);
    expect(isSubscriptionActive("trialing")).toBe(true);
  });

  it("returns false for everything else", () => {
    expect(isSubscriptionActive("inactive")).toBe(false);
    expect(isSubscriptionActive("past_due")).toBe(false);
    expect(isSubscriptionActive("canceled")).toBe(false);
    expect(isSubscriptionActive("unpaid")).toBe(false);
  });
});

describe("resolveLimits", () => {
  it("returns tier defaults when overrides are null", () => {
    const sub: SubscriptionRow = {
      tier: "starter",
      status: "active",
      max_trades_per_day: null,
      max_open_positions: null,
      max_position_usd: null,
      max_markets_watched: null,
    };
    const limits = resolveLimits(sub);
    expect(limits.maxPositionUsd).toBe(TIER_DEFINITIONS.starter.limits.maxPositionUsd);
  });

  it("applies per-customer overrides when present", () => {
    const sub: SubscriptionRow = {
      tier: "starter",
      status: "active",
      max_trades_per_day: null,
      max_open_positions: null,
      max_position_usd: 250, // override
      max_markets_watched: null,
    };
    const limits = resolveLimits(sub);
    expect(limits.maxPositionUsd).toBe(250);
  });

  it("returns free limits when subscription is null", () => {
    const limits = resolveLimits(null);
    expect(limits.liveTradingEnabled).toBe(false);
    expect(limits.maxPositionUsd).toBe(TIER_DEFINITIONS.free.limits.maxPositionUsd);
  });
});

describe("checkEntitlement", () => {
  const activeStarter: SubscriptionRow = {
    tier: "starter",
    status: "active",
    max_trades_per_day: null,
    max_open_positions: null,
    max_position_usd: null,
    max_markets_watched: null,
  };

  it("allows live trading on a paid tier", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      mode: "live",
      strategy: "S-002",
      positionUsd: 50,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks live trading on free tier", () => {
    const r = checkEntitlement({ subscription: null, mode: "live" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Live trading/i);
  });

  it("allows past_due subscriptions in paper mode (paper always passes)", () => {
    const sub: SubscriptionRow = { ...activeStarter, status: "past_due" };
    const r = checkEntitlement({ subscription: sub, mode: "paper" });
    expect(r.allowed).toBe(true);
  });

  it("blocks past_due subscriptions in live mode", () => {
    const sub: SubscriptionRow = { ...activeStarter, status: "past_due" };
    const r = checkEntitlement({ subscription: sub, mode: "live" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/past_due/);
  });

  it("blocks strategies not allowed on the tier", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-005", // weather, only on pro+
      mode: "live",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/S-005/);
  });

  // Regression guard for the prefix-bypass: entitlement used to normalize with
  // /^S-\d+/, so ANY strategy id prefixed with an entitled template — e.g. a
  // user-named "S-002-drain-account" — inherited that template's live access.
  // Matching is now exact; callers resolve instance ids to their DB row's
  // template_id before calling.
  it("denies a strategy that merely PREFIXES an entitled template id", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-002-drain-account",
      mode: "live",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies suffixed instance ids directly — callers must resolve template_id first", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-001-l-ea207ba1",
      mode: "live",
    });
    expect(r.allowed).toBe(false);
  });

  it("fails closed: live mode with no resolvable template is denied", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: undefined,
      mode: "live",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/template/i);
  });

  it("paper mode still passes without any template lineage", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: undefined,
      mode: "paper",
    });
    expect(r.allowed).toBe(true);
  });

  it("allows S-005 on pro tier", () => {
    const proSub: SubscriptionRow = { ...activeStarter, tier: "pro" };
    const r = checkEntitlement({
      subscription: proSub,
      strategy: "S-005",
      mode: "live",
    });
    expect(r.allowed).toBe(true);
  });

  it("allows a position within the tier's max size", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-002",
      mode: "live",
      positionUsd: 100, // starter cap is exactly $100
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks a position over the tier's max size", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-002",
      mode: "live",
      positionUsd: 10_000, // starter cap is $100
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/max position size/);
  });

  it("blocks S-003 on every tier in live mode (it's disabled per Fed paper)", () => {
    for (const tier of ["starter", "pro", "prop"] as const) {
      const sub: SubscriptionRow = { ...activeStarter, tier };
      const r = checkEntitlement({
        subscription: sub,
        strategy: "S-003",
        mode: "live",
      });
      expect(r.allowed).toBe(false);
    }
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const body = '{"id":"evt_test","type":"checkout.session.completed"}';

  async function makeStripeHeader(payload: string, ts: number, key: string): Promise<string> {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      enc.encode(`${ts}.${payload}`)
    );
    const hex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${ts},v1=${hex}`;
  }

  it("accepts a valid signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await makeStripeHeader(body, ts, secret);
    const result = await verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await makeStripeHeader(body, ts, secret);
    const result = await verifyStripeSignature(body + "x", header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Signature mismatch/);
  });

  it("rejects a wrong secret", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await makeStripeHeader(body, ts, secret);
    const result = await verifyStripeSignature(body, header, "whsec_wrong_secret");
    expect(result.valid).toBe(false);
  });

  it("rejects an old timestamp (replay protection)", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const header = await makeStripeHeader(body, oldTs, secret);
    const result = await verifyStripeSignature(body, header, secret, 300);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it("rejects a missing header", async () => {
    const result = await verifyStripeSignature(body, "", secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Missing/);
  });

  it("rejects a malformed header", async () => {
    const result = await verifyStripeSignature(body, "garbage", secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Malformed/);
  });
});

describe("priceIdToTier", () => {
  const env = {
    STRIPE_PRICE_STARTER: "price_starter_abc",
    STRIPE_PRICE_PRO: "price_pro_def",
    STRIPE_PRICE_PROP: "price_prop_ghi",
  };

  it("maps known price ids to tiers", () => {
    expect(priceIdToTier("price_starter_abc", env)).toBe("starter");
    expect(priceIdToTier("price_pro_def", env)).toBe("pro");
    expect(priceIdToTier("price_prop_ghi", env)).toBe("prop");
  });

  it("returns free for unknown or null price ids", () => {
    expect(priceIdToTier(null, env)).toBe("free");
    expect(priceIdToTier(undefined, env)).toBe("free");
    expect(priceIdToTier("price_unknown", env)).toBe("free");
  });
});
