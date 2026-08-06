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
 * Strategies that actually execute in `auto-trade` today, with their canonical
 * names from `supabase/migrations/20260406_replace_strategies.sql`.
 *
 * S-004 (Liquidity Provision) is deliberately absent: it is listed in the server's
 * `allowedStrategies` entitlement but has no implementation in auto-trade and no
 * rows in the `strategies` table, so no plan may advertise it. Entitling a
 * strategy is not the same as shipping one — pricing copy tracks what runs.
 */
export const LIVE_STRATEGIES: Record<string, string> = {
  "S-001": "Surface Arbitrage",
  "S-002": "Resolution Fade",
  "S-005": "Weather Edge",
};

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
  /** Human-readable summary of `allowedStrategies` for this tier */
  strategiesLabel: string;
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
    strategiesLabel: "Every live strategy, paper only",
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
    strategiesLabel: "S-001 Surface Arbitrage + S-002 Resolution Fade",
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
    strategiesLabel: "Adds S-005 Weather Edge — every live strategy",
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
    strategiesLabel: "Every live strategy + priority execution",
    extras: ["Everything in Pro", "Dedicated support channel"],
    highlight: false,
  },
];

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

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
    tier.strategiesLabel,
    ...tier.extras,
  ];
}

/** Formatted monthly price, e.g. "$0", "$99", "$999" */
export function tierPriceLabel(tier: PricingTier): string {
  return usd(tier.monthlyPriceUsd);
}

export const FREE_TIER = PRICING_TIERS[0];
export const PAID_TIERS = PRICING_TIERS.filter((t) => t.monthlyPriceUsd > 0);
