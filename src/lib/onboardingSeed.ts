/**
 * The strategy set a brand-new account is seeded with at the end of onboarding.
 *
 * Extracted from OnboardingPage so the `active` defaults are covered by a test.
 * These flags decide, unattended, which strategies start trading a new user's
 * balance the moment they finish the wizard — a strategy switched on here needs
 * a track record that justifies it, and that claim needs a regression guard.
 *
 * Enabling posture: a strategy ships `active: true` only while its most recent
 * fill-simulated sample shows positive expectancy net of fees. Anything else
 * ships off and is opt-in from the Strategies panel.
 */

export interface SeededStrategy {
  id: string;
  template_id: string;
  name: string;
  description: string;
  instructions: string;
  active: boolean;
  mode: "paper";
  starting_balance: number;
  user_id: string;
}

/**
 * Templates that must never be seeded active until they clear the bar above.
 * The test asserts this list against what buildSeededStrategies actually emits,
 * so re-enabling one is a deliberate two-file change, not a one-character slip.
 */
export const DISABLED_BY_DEFAULT_TEMPLATES = ["S-002", "S-005"] as const;

export function buildSeededStrategies(userId: string): SeededStrategy[] {
  const uid8 = userId.replace(/-/g, "").slice(0, 8);

  return [
    {
      id: `S-001-${uid8}`,
      template_id: "S-001",
      name: "Surface Arbitrage",
      description: "Exploits bracket-sum mispricing in KXINX/KXBTC/KXETH markets.",
      instructions:
        "Read surface_alerts for bracket_sum_violation. Buy NO on the most overpriced YES legs (yesAsk descending). Max 3 legs per event at $15/leg. Mark alert is_exploited after fill. No LLM gate — structural edge.",
      active: true,
      mode: "paper",
      starting_balance: 500,
      user_id: userId,
    },
    {
      // Seeded inactive — negative EV in current market conditions.
      // User can enable it manually from the Strategies panel after reviewing track record.
      id: `S-002-${uid8}`,
      template_id: "S-002",
      name: "Resolution Fade",
      description: "Fade overreaction price moves in markets 2–7 days from resolution.",
      instructions:
        "Use fetch_signals filtered to time_value_score >= 0.7 and edge_score >= 0.4. Fade sentiment-driven extremes with $20–$40 limit orders. Exit when price reverts 10¢ toward prior range.",
      active: false,
      mode: "paper",
      starting_balance: 1000,
      user_id: userId,
    },
    {
      // Seeded inactive — negative EV on the only sample that faces realistic fills.
      // Measured over the 30 settled trades since fill simulation landed (2026-07-27):
      // all NO side, average entry 42.9¢ (break-even win rate 42.9%), realised win rate
      // 23.3%, expectancy −$6.45/trade. Its lifetime profit comes entirely from the
      // sub-25¢ band (+$260 over 23 trades at an 8.7% win rate — two outliers carrying
      // the line); every other entry band loses money. Before this changed, the health
      // monitor was suspending S-005 for consecutive_loss_streak and auto-resuming it
      // on a ~13h cycle, so a new user's default state was a revolving loss loop.
      // Re-enable by default only once it clears break-even over 100+ fill-simulated trades.
      id: `S-005-${uid8}`,
      template_id: "S-005",
      name: "Weather Edge",
      description: "Trades NWS forecast vs Kalshi implied temperature divergence.",
      instructions:
        "Compare NWS probability-of-precipitation and temperature forecasts to Kalshi Weather markets. Trade when divergence exceeds 15¢. Size $15–$30.",
      active: false,
      mode: "paper",
      starting_balance: 1000,
      user_id: userId,
    },
  ];
}
