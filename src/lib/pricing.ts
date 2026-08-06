/**
 * Single source of truth for every price, limit, and plan bundle the UI shows.
 *
 * The server enforces the same numbers from `supabase/functions/_shared/billing.ts`
 * (`TIER_DEFINITIONS`), which stays authoritative for enforcement. This file is
 * authoritative for what the product *says* — and `src/lib/pricing.test.ts` fails
 * the build if the two ever disagree, so marketing copy on the landing page can't
 * drift away from what the agent will actually let a user do.
 *
 * Both the landing page and the in-app billing page render from this array. Adding
 * a tier, changing a price, or changing a limit happens here and in billing.ts —
 * nowhere else.
 */

export type PricingTierId = "free" | "starter" | "pro" | "prop";

/**
 * Strategy IDs `auto-trade` has an explicit handler for. Its dispatcher hard-
 * rejects anything else, so this is the set a customer can actually run.
 *
 * Pricing copy never names these. Strategy identifiers are internal — a
 * prospect cannot evaluate "S-002 Resolution Fade", the roster changes without
 * a pricing change, and naming one we later retire turns the page into a
 * liability. Plans advertise how many strategies a tier unlocks; the count is
 * derived below so it cannot drift from what the engine will run.
 */
export const LIVE_STRATEGIES = ["S-001", "S-002", "S-005"];

export interface PricingTier {
  id: PricingTierId;
  /** Display name, matches `TierDefinition.displayName` for paid tiers */
  name: string;
  monthlyPriceUsd: number;
  /** One-line positioning, used on both surfaces */
  description: string;
  maxTradesPerDay: number;
  maxOpenPositions: number;
  maxPositionUsd: number;
  liveTradingEnabled: boolean;
  /**
   * How many of `LIVE_STRATEGIES` this tier unlocks. Must equal the size of the
   * tier's server-side `allowedStrategies` intersected with what auto-trade can
   * actually run — `pricing.test.ts` enforces it.
   */
  strategyCount: number;
  /** Non-numeric differentiators, appended after the limit bullets */
  extras: string[];
  /** Exactly one tier carries this; both surfaces badge the same plan */
  highlight: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free Trial",
    monthlyPriceUsd: 0,
    description: "Build your track record with zero risk.",
    maxTradesPerDay: 5,
    maxOpenPositions: 3,
    maxPositionUsd: 25,
    liveTradingEnabled: false,
    strategyCount: 3,
    extras: ["Agent chat + memory", "Performance analytics", "No credit card required"],
    highlight: false,
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPriceUsd: 99,
    description: "For traders who want real live executions.",
    maxTradesPerDay: 25,
    maxOpenPositions: 8,
    maxPositionUsd: 100,
    liveTradingEnabled: true,
    strategyCount: 2,
    extras: ["Everything in Free", "Strategies run automatically 24/7"],
    highlight: false,
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: 199,
    description: "Full access — every live strategy, bigger positions.",
    maxTradesPerDay: 100,
    maxOpenPositions: 25,
    maxPositionUsd: 500,
    liveTradingEnabled: true,
    strategyCount: 3,
    extras: ["Everything in Starter", "Priority support", "Early access to new strategies"],
    highlight: true,
  },
  {
    id: "prop",
    name: "Prop",
    monthlyPriceUsd: 999,
    description: "For serious operators deploying real capital.",
    maxTradesPerDay: 1000,
    maxOpenPositions: 100,
    maxPositionUsd: 5000,
    liveTradingEnabled: true,
    strategyCount: 3,
    extras: ["Everything in Pro", "Priority execution", "Dedicated support channel"],
    highlight: false,
  },
];

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * How a tier's strategy access reads on a pricing card. Deliberately generic —
 * see the note on LIVE_STRATEGIES for why identifiers stay out of pricing copy.
 */
export function strategiesLabel(tier: PricingTier): string {
  const all = tier.strategyCount === LIVE_STRATEGIES.length;
  const noun = tier.strategyCount === 1 ? "strategy" : "strategies";
  return all
    ? `All ${tier.strategyCount} automated ${noun}`
    : `${tier.strategyCount} automated ${noun}`;
}

/**
 * The bullet list shown for a tier. Derived from the limit fields so every number
 * a user reads is the same number the server enforces — there is no second place
 * to edit "25 trades / day" into something the agent won't honor.
 */
export function tierFeatures(tier: PricingTier): string[] {
  return [
    `${tier.maxTradesPerDay.toLocaleString("en-US")} trades / day`,
    `${tier.maxOpenPositions} open positions`,
    `${usd(tier.maxPositionUsd)} max position`,
    tier.liveTradingEnabled ? "Live trading enabled" : "Paper trading only",
    strategiesLabel(tier),
    ...tier.extras,
  ];
}

/** Formatted monthly price, e.g. "$0", "$99", "$999" */
export function tierPriceLabel(tier: PricingTier): string {
  return usd(tier.monthlyPriceUsd);
}

export const FREE_TIER = PRICING_TIERS[0];
export const PAID_TIERS = PRICING_TIERS.filter((t) => t.monthlyPriceUsd > 0);
