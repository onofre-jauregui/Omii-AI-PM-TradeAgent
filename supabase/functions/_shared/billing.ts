/**
 * Subscription tier definitions and entitlement checks.
 *
 * The agent has hard limits per subscription tier. These limits are enforced
 * server-side in the auto-trade and execute-trade edge functions. The values
 * here are the SOURCE OF TRUTH — the database `subscriptions` table stores
 * an override for any tier-default that varies per customer (e.g. an
 * enterprise deal with custom limits).
 *
 * Pricing rationale (recalibrated for the $10M / 5-year target):
 *
 * At a $10M target with the bootstrapped path, we need fewer but higher-
 * paying customers, not many low-paying ones. This is why the entry tier
 * is $99/mo, not $19/mo. Bootstrap math at $10M:
 *
 *   200 customers × $99/mo  = ~$240k ARR  (lifestyle-business floor)
 *   500 customers × $199/mo = ~$1.2M ARR  (sale-ready)
 *   100 customers × $999/mo = ~$1.2M ARR  (prop / institutional path)
 *
 * Any of these on its own gets us to a meaningful place. Together they
 * are the SaaS rung of the broader plan.
 */

export type Tier = "free" | "starter" | "pro" | "prop";
export type SubscriptionStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid";

export interface TierLimits {
  /** Max trades a single user can place in a 24-hour window */
  maxTradesPerDay: number;
  /** Max simultaneously open positions */
  maxOpenPositions: number;
  /** Max dollar amount per single position */
  maxPositionUsd: number;
  /** Max distinct markets the agent watches per cron tick */
  maxMarketsWatched: number;
  /** Live trading enabled? false = paper-only */
  liveTradingEnabled: boolean;
  /** Strategies the user is allowed to run */
  allowedStrategies: string[];
}

export interface TierDefinition {
  tier: Tier;
  displayName: string;
  monthlyPriceUsd: number;
  limits: TierLimits;
}

/**
 * Strategy availability across tiers. S-003 is intentionally not included
 * because the Fed paper shows Kalshi macro markets are efficient.
 *
 * S-005 (weather) is the new evidence-backed strategy and is included from
 * the Pro tier upward (it's the differentiated value add).
 */
const ALL_STRATEGIES = ["S-001", "S-002", "S-004", "S-005"];

export const TIER_DEFINITIONS: Record<Tier, TierDefinition> = {
  free: {
    tier: "free",
    displayName: "Free Trial",
    monthlyPriceUsd: 0,
    limits: {
      maxTradesPerDay: 999999,
      maxOpenPositions: 999999,
      maxPositionUsd: 999999,
      maxMarketsWatched: 999999,
      liveTradingEnabled: false,
      allowedStrategies: ALL_STRATEGIES, // paper trades always allowed regardless of strategy
    },
  },
  starter: {
    tier: "starter",
    displayName: "Starter",
    monthlyPriceUsd: 99,
    limits: {
      maxTradesPerDay: 999999,
      maxOpenPositions: 999999,
      maxPositionUsd: 999999, // user enforces via in-app risk controls
      maxMarketsWatched: 999999,
      liveTradingEnabled: true,
      allowedStrategies: ["S-001", "S-002", "S-004"],
    },
  },
  pro: {
    tier: "pro",
    displayName: "Pro",
    monthlyPriceUsd: 199,
    limits: {
      maxTradesPerDay: 999999,
      maxOpenPositions: 999999,
      maxPositionUsd: 999999, // user enforces via in-app risk controls
      maxMarketsWatched: 999999,
      liveTradingEnabled: true,
      allowedStrategies: ALL_STRATEGIES,
    },
  },
  prop: {
    tier: "prop",
    displayName: "Prop",
    monthlyPriceUsd: 999,
    limits: {
      maxTradesPerDay: 999999,
      maxOpenPositions: 999999,
      maxPositionUsd: 999999,
      maxMarketsWatched: 999999,
      liveTradingEnabled: true,
      allowedStrategies: ALL_STRATEGIES,
    },
  },
};

export interface SubscriptionRow {
  tier: Tier;
  status: SubscriptionStatus;
  // Optional per-customer overrides; null means "use tier default"
  max_trades_per_day: number | null;
  max_open_positions: number | null;
  max_position_usd: number | null;
  max_markets_watched: number | null;
}

/**
 * Returns true if the subscription status allows the user to use the agent.
 */
export function isSubscriptionActive(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Resolve effective limits for a subscription row. Falls back to the tier
 * default for any field that is null on the row, so per-customer overrides
 * win when they exist.
 */
export function resolveLimits(sub: SubscriptionRow | null): TierLimits {
  // No subscription = treat as free trial limits
  const tier = sub?.tier || "free";
  const def = TIER_DEFINITIONS[tier];
  if (!def) {
    return TIER_DEFINITIONS.free.limits;
  }

  return {
    maxTradesPerDay: sub?.max_trades_per_day ?? def.limits.maxTradesPerDay,
    maxOpenPositions: sub?.max_open_positions ?? def.limits.maxOpenPositions,
    maxPositionUsd: sub?.max_position_usd ?? def.limits.maxPositionUsd,
    maxMarketsWatched: sub?.max_markets_watched ?? def.limits.maxMarketsWatched,
    liveTradingEnabled: def.limits.liveTradingEnabled,
    allowedStrategies: def.limits.allowedStrategies,
  };
}

/**
 * Check whether a specific action is allowed for the subscription.
 */
export interface EntitlementCheckInput {
  subscription: SubscriptionRow | null;
  strategy?: string;
  mode?: "paper" | "live";
  positionUsd?: number;
}

export interface EntitlementCheckResult {
  allowed: boolean;
  reason?: string;
  limits: TierLimits;
}

export function checkEntitlement(
  input: EntitlementCheckInput
): EntitlementCheckResult {
  const limits = resolveLimits(input.subscription);

  // Paper trading requires no subscription — it's the free-tier hook.
  // Strategy gating and live-trading checks are irrelevant for simulated trades.
  if (input.mode === "paper") {
    return { allowed: true, limits };
  }

  // Subscription must be active or trialing
  if (input.subscription && !isSubscriptionActive(input.subscription.status)) {
    return {
      allowed: false,
      reason: `Subscription status is ${input.subscription.status}. Update payment method to continue.`,
      limits,
    };
  }

  // Live trading requires a paid tier
  if (input.mode === "live" && !limits.liveTradingEnabled) {
    return {
      allowed: false,
      reason: "Live trading is not available on your current tier. Upgrade to Starter or higher.",
      limits,
    };
  }

  // Strategy must be allowed
  if (input.strategy && !limits.allowedStrategies.includes(input.strategy)) {
    return {
      allowed: false,
      reason: `Strategy ${input.strategy} is not available on your current tier. Upgrade for access.`,
      limits,
    };
  }

  return { allowed: true, limits };
}

/**
 * Verify a Stripe webhook signature. This is a minimal HMAC-SHA256 check
 * compatible with Stripe's signing scheme: the header value contains
 * `t=<timestamp>,v1=<signature>` and the signature is HMAC-SHA256 of
 * `<timestamp>.<raw body>` using the webhook secret.
 *
 * Stripe's official SDK does this for you in production. We hand-roll it
 * to avoid pulling the entire Stripe SDK into a Deno edge function.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300
): Promise<{ valid: boolean; reason?: string }> {
  if (!signatureHeader) {
    return { valid: false, reason: "Missing Stripe-Signature header" };
  }

  // Parse header: "t=1234567890,v1=abcdef..."
  const parts = Object.fromEntries(
    signatureHeader.split(",").map(p => {
      const idx = p.indexOf("=");
      return idx === -1 ? [p, ""] : [p.slice(0, idx), p.slice(idx + 1)];
    })
  );

  const timestamp = parts["t"];
  const v1Sig = parts["v1"];
  if (!timestamp || !v1Sig) {
    return { valid: false, reason: "Malformed Stripe-Signature header" };
  }

  // Reject events older than tolerance to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return { valid: false, reason: "Invalid timestamp" };
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: `Webhook timestamp outside tolerance (${ageSeconds.toFixed(0)}s old)` };
  }

  // Compute expected signature: HMAC-SHA256("<timestamp>.<body>", secret)
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${rawBody}`)
  );
  const expectedHex = Array.from(new Uint8Array(signed))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare
  if (expectedHex.length !== v1Sig.length) {
    return { valid: false, reason: "Signature length mismatch" };
  }
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ v1Sig.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Map a Stripe price ID to a tier. The mapping lives in env vars so we can
 * change Stripe products without code changes:
 *   STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_PROP
 */
export function priceIdToTier(
  priceId: string | null | undefined,
  env: Record<string, string | undefined>
): Tier {
  if (!priceId) return "free";
  if (priceId === env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === env.STRIPE_PRICE_PROP) return "prop";
  return "free";
}
