import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";

/**
 * signal-generator: Systematic, quantitative signal scoring for Kalshi markets.
 *
 * Separates signal detection from LLM judgment — scores markets across five
 * dimensions before the agent ever sees them, so the LLM acts on pre-ranked
 * opportunities rather than raw data.
 *
 * Scoring dimensions:
 *  1. liquidity_score   — spread tightness + volume depth
 *  2. edge_score        — probability distance from "efficient" 50¢ midpoint
 *  3. momentum_score    — price vs. fair-value proxy (volume-weighted mid)
 *  4. time_value_score  — urgency: closer resolution date = more certain outcome
 *  5. volume_rank_score — relative activity vs. peer markets
 *
 * Returns signals sorted by composite_score descending.
 * Persists signals to the `signals` table for historical tracking.
 */


// ─── Market Series to Score ───────────────────────────────────────────────────
const SERIES = [
  "KXFED", "KXGDP", "KXPAYROLLS", "KXCPI",
  "KXINX", "KXBTC", "KXETH", "KXNHL", "KXNBA",
  "KXMLB", "KXCHCUTS",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawMarket {
  ticker: string;
  title?: string;
  subtitle?: string;
  yes_bid?: number;
  yes_ask?: number;
  yes_bid_dollars?: number;
  yes_ask_dollars?: number;
  last_price?: number;
  last_price_dollars?: number;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  close_time?: string;
  event_ticker?: string;
}

interface ScoredSignal {
  ticker: string;
  title: string;
  event_ticker: string;
  yes_bid: number;
  yes_ask: number;
  mid_price: number;
  spread: number;
  volume: number;
  close_time: string | null;
  days_to_close: number | null;
  // Scores (0.0 – 1.0)
  liquidity_score: number;
  edge_score: number;
  time_value_score: number;
  volume_rank_score: number;
  composite_score: number;
  // Signal output
  direction: "buy_yes" | "buy_no" | "skip";
  signal_strength: "strong" | "moderate" | "weak";
  reasoning: string;
}

// ─── Scoring Helpers ──────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Liquidity score: rewards tight spread + volume depth.
 * spread is in cents (0–99). volume is raw contract count.
 */
function scoreLiquidity(spreadCents: number, volume: number): number {
  // Spread component: 0c = 1.0, 20c+ = 0.0
  const spreadScore = clamp(1 - spreadCents / 20);
  // Volume component: log-normalised, 10k+ contracts → 1.0
  const volScore = clamp(Math.log10(Math.max(volume, 1)) / 4);
  return spreadScore * 0.6 + volScore * 0.4;
}

/**
 * Edge score: how far the mid-price is from the "boring" 50¢ midpoint.
 * Extremes (< 10¢ or > 90¢) suggest strong conviction or mispricing.
 * We reward distance from 50 — higher = more extreme = more interesting.
 */
function scoreEdge(midCents: number): number {
  const distFrom50 = Math.abs(midCents - 50);
  // 0 distance = 0 edge, 50 distance = 1.0 edge
  return clamp(distFrom50 / 50);
}

/**
 * Time value score: markets closing soon are more "resolvable."
 * Within 7 days → 1.0, >90 days → 0.0.
 */
function scoreTimeValue(daysToClose: number | null): number {
  if (daysToClose === null || daysToClose < 0) return 0;
  if (daysToClose <= 1) return 1.0;
  if (daysToClose <= 7) return 0.9;
  if (daysToClose <= 14) return 0.7;
  if (daysToClose <= 30) return 0.5;
  if (daysToClose <= 60) return 0.3;
  return 0.1;
}

/**
 * Volume rank score: relative rank within the current batch (0–1).
 * Assigned after all markets are scored.
 */
function assignVolumeRanks(signals: ScoredSignal[]): void {
  const sorted = [...signals].sort((a, b) => b.volume - a.volume);
  sorted.forEach((s, i) => {
    const market = signals.find((m) => m.ticker === s.ticker)!;
    market.volume_rank_score = clamp(1 - i / Math.max(sorted.length - 1, 1));
  });
}

/**
 * Composite score: weighted combination of individual scores.
 * Liquidity is the gate — a great edge on an illiquid market is worthless.
 */
function compositeScore(s: ScoredSignal): number {
  return (
    s.liquidity_score * 0.35 +
    s.edge_score * 0.25 +
    s.time_value_score * 0.20 +
    s.volume_rank_score * 0.20
  );
}

/**
 * Determine signal direction from mid-price.
 * Cheap YES (< 25¢): potential buy YES if liquidity allows (mean-reversion or value).
 * Expensive YES (> 75¢): potential buy NO (equivalent of shorting YES).
 * Mid-range: skip unless very liquid and close to resolution.
 */
function deriveDirection(
  midCents: number,
  liquidity: number,
  edge: number,
  timeValue: number
): { direction: ScoredSignal["direction"]; reasoning: string } {
  const cheap = midCents < 25;
  const expensive = midCents > 75;
  const actionable = liquidity > 0.3 && (edge > 0.3 || timeValue > 0.7);

  if (cheap && actionable) {
    return {
      direction: "buy_yes",
      reasoning: `YES trading at ${midCents.toFixed(0)}¢ — potential value if event resolves YES. Liquidity score ${(liquidity * 100).toFixed(0)}%.`,
    };
  }
  if (expensive && actionable) {
    return {
      direction: "buy_no",
      reasoning: `YES at ${midCents.toFixed(0)}¢ → equivalent NO at ${(100 - midCents).toFixed(0)}¢. Potential value on NO side. Liquidity score ${(liquidity * 100).toFixed(0)}%.`,
    };
  }
  if (Math.abs(midCents - 50) < 5 && timeValue > 0.8 && liquidity > 0.5) {
    return {
      direction: "buy_yes",
      reasoning: `Near 50¢ with ${timeValue > 0.9 ? "imminent" : "near-term"} resolution — coin-flip with momentum potential. High liquidity.`,
    };
  }
  return {
    direction: "skip",
    reasoning: `Mid-range price (${midCents.toFixed(0)}¢) with insufficient edge or liquidity to act. Monitor.`,
  };
}

function signalStrength(score: number): ScoredSignal["signal_strength"] {
  if (score >= 0.65) return "strong";
  if (score >= 0.45) return "moderate";
  return "weak";
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

  try {
    let body: any = {};
    try { body = await req.json(); } catch {}

    const { markets: incomingMarkets, limit = 20, category } = body;

    // ── Fetch markets if none provided ───────────────────────────────────────
    let rawMarkets: RawMarket[] = [];

    if (incomingMarkets && Array.isArray(incomingMarkets) && incomingMarkets.length > 0) {
      rawMarkets = incomingMarkets;
    } else {
      const targetSeries = category ? [category] : SERIES;
      const fetches = targetSeries.map((s) =>
        fetch(`${KALSHI_BASE_URL}/markets?limit=25&status=open&series_ticker=${s}`)
          .then((r) => r.json())
          .catch(() => ({ markets: [] }))
      );
      const results = await Promise.all(fetches);
      for (const result of results) {
        for (const m of result.markets || []) rawMarkets.push(m);
      }
    }

    // ── Filter to liquid markets ──────────────────────────────────────────────
    const isLiquid = (m: RawMarket): boolean => {
      if ((m.ticker || "").startsWith("KXMVE")) return false;
      const ya = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
      const yb = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
      const last = Number(m.last_price_dollars ?? m.last_price) || 0;
      return ya > 0.005 || yb > 0.005 || last > 0.005;
    };

    rawMarkets = rawMarkets.filter(isLiquid);

    // Deduplicate by ticker
    const seen = new Set<string>();
    rawMarkets = rawMarkets.filter((m) => {
      if (seen.has(m.ticker)) return false;
      seen.add(m.ticker);
      return true;
    });

    if (rawMarkets.length === 0) {
      return new Response(
        JSON.stringify({ signals: [], total_scored: 0, note: "No liquid markets available to score." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Score each market ─────────────────────────────────────────────────────
    const now = Date.now();
    const signals: ScoredSignal[] = [];

    for (const m of rawMarkets) {
      const yesBid = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
      const yesAsk = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
      const lastPrice = Number(m.last_price_dollars ?? m.last_price) || 0;
      const volume = Number(m.volume || m.volume_24h) || 0;

      // Compute mid in cents (0–100)
      const midDollars = yesAsk > 0 && yesBid > 0
        ? (yesBid + yesAsk) / 2
        : lastPrice || 0.5;
      const midCents = midDollars * 100;
      const spreadCents = yesAsk > 0 && yesBid > 0
        ? (yesAsk - yesBid) * 100
        : 20; // penalise if no orderbook data

      // Time to close
      let daysToClose: number | null = null;
      if (m.close_time) {
        const closeMs = new Date(m.close_time).getTime();
        daysToClose = (closeMs - now) / (1000 * 60 * 60 * 24);
        if (daysToClose < 0) continue; // skip already-closed markets
      }

      const liquidityScore = scoreLiquidity(spreadCents, volume);
      const edgeScore = scoreEdge(midCents);
      const timeValueScore = scoreTimeValue(daysToClose);
      const { direction, reasoning } = deriveDirection(midCents, liquidityScore, edgeScore, timeValueScore);

      const signal: ScoredSignal = {
        ticker: m.ticker,
        title: m.title || m.subtitle || m.ticker,
        event_ticker: m.event_ticker || m.ticker.split("-").slice(0, 2).join("-"),
        yes_bid: Math.round(yesBid * 100),
        yes_ask: Math.round(yesAsk * 100),
        mid_price: Math.round(midCents),
        spread: Math.round(spreadCents),
        volume,
        close_time: m.close_time || null,
        days_to_close: daysToClose !== null ? Math.round(daysToClose * 10) / 10 : null,
        liquidity_score: Math.round(liquidityScore * 100) / 100,
        edge_score: Math.round(edgeScore * 100) / 100,
        time_value_score: Math.round(timeValueScore * 100) / 100,
        volume_rank_score: 0, // filled in below
        composite_score: 0,   // filled in below
        direction,
        signal_strength: "weak",
        reasoning,
      };

      signals.push(signal);
    }

    // ── Post-process: assign relative volume ranks + composite score ──────────
    assignVolumeRanks(signals);
    for (const s of signals) {
      s.composite_score = Math.round(compositeScore(s) * 100) / 100;
      s.signal_strength = signalStrength(s.composite_score);
    }

    // Sort: strong actionable signals first, then by composite score
    signals.sort((a, b) => {
      const actionA = a.direction !== "skip" ? 1 : 0;
      const actionB = b.direction !== "skip" ? 1 : 0;
      if (actionA !== actionB) return actionB - actionA;
      return b.composite_score - a.composite_score;
    });

    const topSignals = signals.slice(0, limit);

    // ── Persist to signals table (non-blocking) ───────────────────────────────
    if (supabase && topSignals.length > 0) {
      const rows = topSignals.map((s) => ({
        ticker: s.ticker,
        market_question: s.title,
        event_ticker: s.event_ticker,
        direction: s.direction,
        mid_price: s.mid_price,
        spread: s.spread,
        volume: s.volume,
        composite_score: s.composite_score,
        liquidity_score: s.liquidity_score,
        edge_score: s.edge_score,
        time_value_score: s.time_value_score,
        volume_rank_score: s.volume_rank_score,
        signal_strength: s.signal_strength,
        reasoning: s.reasoning,
        days_to_close: s.days_to_close,
        expires_at: s.close_time,
      }));

      supabase.from("signals").insert(rows).then().catch((e: Error) => {
        console.error("Failed to persist signals:", e.message);
      });
    }

    // ── Summary stats ─────────────────────────────────────────────────────────
    const actionable = topSignals.filter((s) => s.direction !== "skip");
    const strong = topSignals.filter((s) => s.signal_strength === "strong");

    return new Response(
      JSON.stringify({
        signals: topSignals,
        total_scored: signals.length,
        summary: {
          actionable: actionable.length,
          strong: strong.length,
          avg_composite_score: signals.length > 0
            ? Math.round((signals.reduce((s, x) => s + x.composite_score, 0) / signals.length) * 100) / 100
            : 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("signal-generator error:", e);

    if (supabase) {
      supabase.from("compliance_log").insert({
        event_type: "signal_generator_error",
        severity: "error",
        message: `Signal generator failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined },
      }).then().catch(() => {});
    }

    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
