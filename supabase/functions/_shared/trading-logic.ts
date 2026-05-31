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
export function computePnl(
  side: string,
  action: string,
  priceInCents: number,
  amountUsd: number,
  result: string
): { pnl: number; outcome: "win" | "loss" | "void" } {
  if (result !== "yes" && result !== "no") {
    return { pnl: 0, outcome: "void" };
  }
  const priceDollars = priceInCents / 100;
  const contracts = priceDollars > 0 ? amountUsd / priceDollars : 0;

  if (action !== "buy") {
    return { pnl: 0, outcome: "void" };
  }

  const correctSide = (side === "yes" && result === "yes") || (side === "no" && result === "no");
  if (correctSide) {
    return { pnl: contracts * (1 - priceDollars), outcome: "win" };
  }
  return { pnl: -contracts * priceDollars, outcome: "loss" };
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

/** Volume gate: require >= 200 contracts for reliable price discovery. */
export function s002VolumeCheck(volume: number): boolean {
  return volume >= 200;
}

/**
 * Edge floor: require >= 3¢ true-vs-implied divergence.
 * Returns {passes: true} or {passes: false, detail: "skipped: edge_cents=X¢ below 3¢ floor"}.
 */
export function s002EdgeCentsCheck(
  edgeCents: number
): { passes: boolean; detail?: string } {
  if (edgeCents >= 3) return { passes: true };
  return { passes: false, detail: `skipped: edge_cents=${edgeCents}¢ below 3¢ floor` };
}

// ─── S-005 Weather Edge City Gate ─────────────────────────────────────────────

/**
 * Build the set of cities that must go through the LLM gate regardless of edge.
 * Cities with >= lossThreshold NO losses in the tracking window are forced through.
 */
export function buildForceLlmCities(
  cityWinLoss: Map<string, { wins: number; losses: number; totalPnl: number }>,
  lossThreshold = 3
): Set<string> {
  const forced = new Set<string>();
  for (const [city, stat] of cityWinLoss) {
    if (stat.losses >= lossThreshold) forced.add(city);
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
