/**
 * Pure trading logic extracted from auto-trade and auto-settle for unit testability.
 * No Deno or Supabase imports — safe to import from both Deno edge functions and Vitest.
 */

// ─── P&L Computation ──────────────────────────────────────────────────────────

/**
 * Compute realized PnL for a single trade given the Kalshi market result.
 * Kalshi contracts pay $1 per contract if correct, $0 otherwise.
 * Amount is USD deployed; priceInCents is entry price (1–99).
 */
/**
 * feeCents: total attributable cost in cents to subtract for net_pnl — Kalshi
 * entry + exit fee (see docs/design/full-transaction-cost.md, Option A). AI
 * qualify cost isn't folded in here yet (no pricing table exists) — net_pnl
 * is fee-only for now, an honest partial step toward the design's full number.
 * Gross pnl is always returned unmodified alongside net_pnl.
 */
export function computePnl(
  side: string,
  action: string,
  priceInCents: number,
  amountUsd: number,
  result: string,
  feeCents = 0
): { pnl: number; netPnl: number; outcome: "win" | "loss" | "void" } {
  if (result !== "yes" && result !== "no") {
    return { pnl: 0, netPnl: 0, outcome: "void" };
  }
  const priceDollars = priceInCents / 100;
  const contracts = priceDollars > 0 ? amountUsd / priceDollars : 0;
  const feeDollars = feeCents / 100;

  if (action !== "buy") {
    return { pnl: 0, netPnl: 0, outcome: "void" };
  }

  const correctSide = (side === "yes" && result === "yes") || (side === "no" && result === "no");
  if (correctSide) {
    const pnl = contracts * (1 - priceDollars);
    return { pnl, netPnl: pnl - feeDollars, outcome: "win" };
  }
  const pnl = -contracts * priceDollars;
  return { pnl, netPnl: pnl - feeDollars, outcome: "loss" };
}

// ─── Kalshi Status Resolution ─────────────────────────────────────────────────

/**
 * Determine what action to take for a Kalshi market given its status and result field.
 * Returns "settle" (compute P&L), "void" (refund at cost), or "skip" (still open).
 */
export function resolveKalshiMarketAction(
  status: string,
  result?: string
): "settle" | "void" | "skip" {
  if (["voided", "cancelled"].includes(status)) return "void";

  const hasResult =
    typeof result === "string" &&
    result !== "" &&
    result !== "undetermined";

  if (status === "finalized" || status === "settled" || hasResult) return "settle";

  return "skip";
}

// ─── Win Streak ───────────────────────────────────────────────────────────────

/**
 * Compute consecutive profitable days from already-fetched settled trade data.
 * Injectable nowMs for deterministic testing.
 */
export function computeWinStreakFromTrades(
  trades: { settled_at: string | null; pnl: number | null }[],
  nowMs?: number
): number {
  if (!trades || trades.length === 0) return 0;

  const byDay: Record<string, number> = {};
  for (const t of trades) {
    const day = (t.settled_at ?? "").slice(0, 10);
    if (day) byDay[day] = (byDay[day] ?? 0) + (t.pnl ?? 0);
  }

  const days = Object.keys(byDay).sort().reverse();
  if (days.length === 0) return 0;

  // Break streak if the most recent settled day is more than 1 calendar day ago
  const lastDay = new Date(days[0] + "T12:00:00Z");
  const nowNoon = new Date(nowMs ?? Date.now());
  nowNoon.setUTCHours(12, 0, 0, 0);
  const daysSinceLast = Math.floor((nowNoon.getTime() - lastDay.getTime()) / 86_400_000);
  if (daysSinceLast > 1) return 0;

  let streak = 0;
  const cursor = new Date(days[0] + "T12:00:00Z");
  const MAX_STREAK = 200;
  while (streak < MAX_STREAK) {
    const key = cursor.toISOString().slice(0, 10);
    if (!byDay[key] || byDay[key] <= 0) break;
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// ─── S-002 Longshot Bias Filters ──────────────────────────────────────────────

/**
 * Volume gate: require >= 150 contracts with a spread guard.
 * 200 was borrowed from equity options and excluded too much of the Kalshi longshot
 * universe. 150 is the lower bound; spread <= 3¢ compensates for lower volume by
 * ensuring price discovery is still reliable.
 */
export function s002VolumeCheck(volume: number, spreadCents?: number): boolean {
  if (volume >= 150) {
    // Spread guard: if spread provided, reject wide markets regardless of volume.
    if (spreadCents !== undefined && spreadCents > 3) return false;
    return true;
  }
  return false;
}

/**
 * Edge floor: require >= 4¢ true-vs-implied divergence.
 * The academic edge at the 8-11¢ YES range is ~5pp (7% true vs 12% implied). At
 * 10¢ YES this is ~0.5¢ raw probability edge per contract; the 4¢ floor on the
 * aggregated signal-level edge_cents field keeps out stale/noisy signals that don't
 * reflect the full structural premium.
 */
export function s002EdgeCentsCheck(
  edgeCents: number
): { passes: boolean; detail?: string } {
  if (edgeCents >= 4) return { passes: true };
  return { passes: false, detail: `skipped: edge_cents=${edgeCents}¢ below 4¢ floor` };
}

/**
 * Duration-based slot weight for S-002 positions.
 * Literature supports stronger longshot bias in shorter-duration contracts — we
 * prefer them and weight the cap accordingly.
 *   ≤ 3d  → weight 1.0 (full slot; strongest bias signal)
 *   3-7d  → weight 0.75
 *   > 7d  → weight 0.5  (weakest; limit exposure in uncertain far-term)
 */
export function s002SlotWeight(daysToClose: number): number {
  if (daysToClose <= 3) return 1.0;
  if (daysToClose <= 7) return 0.75;
  return 0.5;
}

/**
 * Auto-qualify bypass: signals in the 8-10¢ YES band with volume >= 300 and
 * edge_cents >= 6 have enough structural confirmation that per-trade LLM review
 * adds noise rather than signal. Mirrors S-005's 30¢ auto-qualify bypass.
 */
export function s002IsAutoQualified(
  yesAsk: number,
  volume: number,
  edgeCents: number
): boolean {
  return yesAsk >= 8 && yesAsk <= 10 && volume >= 300 && edgeCents >= 6;
}

// ─── S-005 Weather Edge City Gate ─────────────────────────────────────────────

/**
 * Build the set of cities that must go through the LLM gate regardless of edge.
 * Cities with >= lossThreshold NO losses in the tracking window are forced through.
 */
export function buildForceLlmCities(
  cityWinLoss: Map<string, { wins: number; losses: number; totalPnl: number }>,
  lossThreshold = 5,
  minLossRate = 0.60,
): Set<string> {
  const forced = new Set<string>();
  for (const [city, stat] of cityWinLoss) {
    const total = stat.wins + stat.losses;
    const lossRate = total > 0 ? stat.losses / total : 0;
    if (stat.losses >= lossThreshold && lossRate >= minLossRate) forced.add(city);
  }
  return forced;
}

/**
 * Returns true if the S-005 signal can be auto-qualified (bypasses LLM gate).
 * False means it must go through LLM review.
 */
export function s005IsAutoQualified(
  edgeCents: number,
  city: string,
  forceLlmCities: Set<string>,
  autoQualifyEdge = 30
): boolean {
  if (edgeCents < autoQualifyEdge) return false;
  if (forceLlmCities.has(city.toLowerCase())) return false;
  return true;
}

// ─── LLM Gate Request Building ────────────────────────────────────────────────

/**
 * Select the correct API endpoint for a given provider.
 * Anthropic native uses /messages; OpenAI-compatible (OpenRouter, OpenAI) uses /chat/completions.
 */
export function buildQualifyEndpoint(provider: string, baseUrl: string): string {
  return provider === "anthropic"
    ? `${baseUrl}/messages`
    : `${baseUrl}/chat/completions`;
}

/**
 * Build the HTTP headers for the LLM qualify request.
 */
export function buildQualifyHeaders(
  provider: string,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://kalshitradeagent.com";
  }
  return headers;
}
