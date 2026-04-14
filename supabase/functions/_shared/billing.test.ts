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

  it("free tier has paper-only and only S-004 (the academically backed maker strategy)", () => {
    const free = TIER_DEFINITIONS.free;
    expect(free.limits.liveTradingEnabled).toBe(false);
    expect(free.limits.allowedStrategies).toEqual(["S-004"]);
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

  it("position limits are monotonically increasing", () => {
    expect(TIER_DEFINITIONS.free.limits.maxPositionUsd).toBeLessThan(
      TIER_DEFINITIONS.starter.limits.maxPositionUsd
    );
    expect(TIER_DEFINITIONS.starter.limits.maxPositionUsd).toBeLessThan(
      TIER_DEFINITIONS.pro.limits.maxPositionUsd
    );
    expect(TIER_DEFINITIONS.pro.limits.maxPositionUsd).toBeLessThan(
      TIER_DEFINITIONS.prop.limits.maxPositionUsd
    );
  });

  it("S-003 (Economic Consensus) is not in any tier per Fed paper evidence", () => {
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      expect(tier.limits.allowedStrategies).not.toContain("S-003");
    }
  });

  it("S-005 (weather) is in pro and prop only", () => {
    expect(TIER_DEFINITIONS.free.limits.allowedStrategies).not.toContain("S-005");
    expect(TIER_DEFINITIONS.starter.limits.allowedStrategies).not.toContain("S-005");
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
      strategy: "S-004",
      positionUsd: 50,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks live trading on free tier", () => {
    const r = checkEntitlement({ subscription: null, mode: "live" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Live trading/i);
  });

  it("blocks past_due subscriptions", () => {
    const sub: SubscriptionRow = { ...activeStarter, status: "past_due" };
    const r = checkEntitlement({ subscription: sub, mode: "paper" });
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

  it("allows S-005 on pro tier", () => {
    const proSub: SubscriptionRow = { ...activeStarter, tier: "pro" };
    const r = checkEntitlement({
      subscription: proSub,
      strategy: "S-005",
      mode: "live",
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks oversized positions", () => {
    const r = checkEntitlement({
      subscription: activeStarter,
      strategy: "S-004",
      mode: "live",
      positionUsd: 10_000, // way over starter's $100 limit
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/exceeds tier limit/);
  });

  it("blocks S-003 on every tier (it's disabled per Fed paper)", () => {
    for (const tier of ["starter", "pro", "prop"] as const) {
      const sub: SubscriptionRow = { ...activeStarter, tier };
      const r = checkEntitlement({
        subscription: sub,
        strategy: "S-003",
        mode: "paper",
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
