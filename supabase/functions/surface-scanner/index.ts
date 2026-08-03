import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { marketFieldCents } from "../_shared/kalshi-prices.ts";
import { alertOnce } from "../_shared/telegram.ts";

/**
 * surface-scanner: Cross-market consistency scanner for Kalshi prediction markets.
 *
 * This is the component that finds the real edge — inconsistencies BETWEEN related
 * markets that should be probabilistically consistent but aren't.
 *
 * Detection types:
 *
 *  1. MONOTONICITY VIOLATION
 *     For threshold markets in the same series (e.g., "BTC > 50k", "BTC > 55k", "BTC > 60k"):
 *     P(BTC > 50k) ≥ P(BTC > 55k) ≥ P(BTC > 60k) must hold.
 *     A violation is a riskless arbitrage: buy the cheap one, sell the expensive one.
 *
 *  2. BRACKET SUM VIOLATION
 *     For MECE discrete-outcome markets in the same event:
 *     Sum of YES prices ≈ 100. Significantly below = collective underpricing.
 *     Significantly above = collective overpricing.
 *
 *  3. SPREAD ANOMALY
 *     Markets in the same event where the bid-ask spread is dramatically wider
 *     than peers — flags stale quotes or manipulated prices worth investigating.
 *
 * Saves alerts to the `surface_alerts` table.
 * Returns ranked opportunities sorted by expected_edge descending.
 */


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
  status?: string;
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

interface ParsedMarket {
  ticker: string;
  title: string;
  event_ticker: string;
  yes_bid_cents: number;
  yes_ask_cents: number;
  mid_cents: number;
  spread_cents: number;
  volume: number;
  close_time: string | null;
  // Parsed threshold value (for threshold-series markets)
  threshold_value: number | null;
}

interface SurfaceAlert {
  alert_type: "monotonicity_violation" | "bracket_sum_violation" | "spread_anomaly";
  event_ticker: string;
  ticker_a: string;
  ticker_b: string | null;
  price_a_cents: number;
  price_b_cents: number | null;
  expected_relationship: string;
  actual_relationship: string;
  expected_edge_cents: number; // how many cents of edge if exploited
  confidence: number;          // 0–1, how reliable this signal is
  action: string;              // what to do about it
  description: string;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseMarket(m: RawMarket): ParsedMarket | null {
  if ((m.ticker || "").startsWith("KXMVE")) return null;

  // Canonical integer cents throughout — the old dollars-assumed read broke on
  // cents-only rows (see _shared/kalshi-prices.ts). This function feeds S-001's
  // bracket-sum math, so a unit error here IS a phantom arbitrage signal.
  const yesBidCents = marketFieldCents(m as any, "yes_bid") ?? 0;
  const yesAskCents = marketFieldCents(m as any, "yes_ask") ?? 0;
  const lastCents = marketFieldCents(m as any, "last_price") ?? 0;

  if (yesAskCents <= 0 && yesBidCents <= 0 && lastCents <= 0) return null;

  const midCents = yesAskCents > 0 && yesBidCents > 0
    ? (yesBidCents + yesAskCents) / 2
    : lastCents || 50;

  const spreadCents = yesAskCents > 0 && yesBidCents > 0
    ? yesAskCents - yesBidCents
    : 20;

  // Derive event_ticker: everything before the last segment after final "-"
  // e.g. KXBTC-26APR4-T56000 → event_ticker = KXBTC-26APR4
  const parts = m.ticker.split("-");
  const eventTicker = m.event_ticker || parts.slice(0, -1).join("-") || m.ticker;

  // Parse threshold from ticker suffix (e.g. T56000 → 56000, T2.5 → 2.5)
  let thresholdValue: number | null = null;
  const lastPart = parts[parts.length - 1] || "";
  const thresholdMatch = lastPart.match(/^T([\d.]+)$/);
  if (thresholdMatch) {
    thresholdValue = parseFloat(thresholdMatch[1]);
  }

  return {
    ticker: m.ticker,
    title: m.title || m.subtitle || m.ticker,
    event_ticker: eventTicker,
    yes_bid_cents: yesBidCents,
    yes_ask_cents: yesAskCents,
    mid_cents: Math.round(midCents),
    spread_cents: Math.round(spreadCents),
    volume: Number(m.volume || m.volume_24h) || 0,
    close_time: m.close_time || null,
    threshold_value: thresholdValue,
  };
}

// ─── Detection Logic ──────────────────────────────────────────────────────────

/**
 * Check monotonicity for threshold markets in the same event.
 * "BTC > 50k" YES ≥ "BTC > 55k" YES — always.
 * A violation means one of these is mispriced relative to the other.
 */
function detectMonotonicityViolations(markets: ParsedMarket[]): SurfaceAlert[] {
  const alerts: SurfaceAlert[] = [];

  // Group by event_ticker, only threshold markets
  const byEvent = new Map<string, ParsedMarket[]>();
  for (const m of markets) {
    if (m.threshold_value === null) continue;
    const list = byEvent.get(m.event_ticker) || [];
    list.push(m);
    byEvent.set(m.event_ticker, list);
  }

  for (const [eventTicker, group] of byEvent.entries()) {
    if (group.length < 2) continue;

    // Sort by threshold ascending
    const sorted = [...group].sort((a, b) => a.threshold_value! - b.threshold_value!);

    for (let i = 0; i < sorted.length - 1; i++) {
      const lower = sorted[i];   // lower threshold → should have higher YES price
      const higher = sorted[i + 1]; // higher threshold → should have lower YES price

      // P(event > lower_threshold) ≥ P(event > higher_threshold)
      if (lower.mid_cents < higher.mid_cents) {
        const edgeCents = higher.mid_cents - lower.mid_cents;

        // Confidence based on spread tightness and edge size
        const avgSpread = (lower.spread_cents + higher.spread_cents) / 2;
        const confidence = Math.max(0, Math.min(1,
          (edgeCents / 10) * (1 - avgSpread / 20)
        ));

        if (edgeCents >= 3 && confidence > 0.2) {
          alerts.push({
            alert_type: "monotonicity_violation",
            event_ticker: eventTicker,
            ticker_a: lower.ticker,
            ticker_b: higher.ticker,
            price_a_cents: lower.mid_cents,
            price_b_cents: higher.mid_cents,
            expected_relationship: `${lower.ticker} YES ≥ ${higher.ticker} YES (lower threshold = higher probability)`,
            actual_relationship: `${lower.ticker} YES = ${lower.mid_cents}¢, ${higher.ticker} YES = ${higher.mid_cents}¢ — INVERTED`,
            expected_edge_cents: edgeCents,
            confidence,
            action: `Buy YES on ${lower.ticker} (${lower.mid_cents}¢) and/or sell YES on ${higher.ticker} (${higher.mid_cents}¢). The spread should close.`,
            description: `Monotonicity violation in ${eventTicker}: "${lower.title}" (threshold ${lower.threshold_value}) priced cheaper than "${higher.title}" (threshold ${higher.threshold_value}). Expected edge: ${edgeCents}¢.`,
          });
        }
      }
    }
  }

  return alerts;
}

/**
 * Check if MECE markets within an event sum correctly to ~100.
 * Flags collective under- or overpricing.
 * Only applies when there are 3+ markets with non-threshold tickers in the same event.
 */
function detectBracketSumViolations(markets: ParsedMarket[]): SurfaceAlert[] {
  const alerts: SurfaceAlert[] = [];

  // Group non-threshold markets by event_ticker
  const byEvent = new Map<string, ParsedMarket[]>();
  for (const m of markets) {
    if (m.threshold_value !== null) continue; // threshold markets handled above
    const list = byEvent.get(m.event_ticker) || [];
    list.push(m);
    byEvent.set(m.event_ticker, list);
  }

  for (const [eventTicker, group] of byEvent.entries()) {
    if (group.length < 3) continue; // need at least 3 to be MECE

    const sumYesCents = group.reduce((s, m) => s + m.mid_cents, 0);

    // Significant underpricing: sum < 85 — collective probability "missing"
    if (sumYesCents < 85) {
      const missingCents = 100 - sumYesCents;
      const perMarket = Math.round(missingCents / group.length);
      const confidence = Math.min(1, missingCents / 20);

      alerts.push({
        alert_type: "bracket_sum_violation",
        event_ticker: eventTicker,
        ticker_a: group[0].ticker,
        ticker_b: null,
        price_a_cents: sumYesCents,
        price_b_cents: 100,
        expected_relationship: `Sum of all YES prices ≈ 100¢ (MECE constraint)`,
        actual_relationship: `Sum of ${group.length} YES prices = ${sumYesCents}¢ — UNDERPRICED by ${missingCents}¢`,
        expected_edge_cents: perMarket,
        confidence,
        action: `All ${group.length} YES markets in ${eventTicker} appear underpriced by ~${perMarket}¢ each. Consider buying the most liquid ones.`,
        description: `Bracket sum violation in ${eventTicker}: ${group.length} MECE markets sum to ${sumYesCents}¢ instead of ~100¢. Collective underpricing of ${missingCents}¢ detected.`,
      });
    }

    // Significant overpricing: sum > 115 — impossible (>100% probability)
    if (sumYesCents > 115) {
      const excessCents = sumYesCents - 100;
      const perMarket = Math.round(excessCents / group.length);
      const confidence = Math.min(1, excessCents / 20);

      alerts.push({
        alert_type: "bracket_sum_violation",
        event_ticker: eventTicker,
        ticker_a: group[0].ticker,
        ticker_b: null,
        price_a_cents: sumYesCents,
        price_b_cents: 100,
        expected_relationship: `Sum of all YES prices ≈ 100¢ (MECE constraint)`,
        actual_relationship: `Sum of ${group.length} YES prices = ${sumYesCents}¢ — OVERPRICED by ${excessCents}¢`,
        expected_edge_cents: perMarket,
        confidence,
        action: `All ${group.length} YES markets in ${eventTicker} appear overpriced. Consider selling YES (buying NO) on the most expensive ones.`,
        description: `Bracket sum violation in ${eventTicker}: ${group.length} markets sum to ${sumYesCents}¢ — exceeds 100¢ by ${excessCents}¢. Arbitrage available through NO positions.`,
      });
    }
  }

  return alerts;
}

/**
 * Detect spread anomalies: markets in the same event with dramatically wider
 * spreads than their peers. Wide = stale quote or thin liquidity.
 */
function detectSpreadAnomalies(markets: ParsedMarket[]): SurfaceAlert[] {
  const alerts: SurfaceAlert[] = [];

  const byEvent = new Map<string, ParsedMarket[]>();
  for (const m of markets) {
    const list = byEvent.get(m.event_ticker) || [];
    list.push(m);
    byEvent.set(m.event_ticker, list);
  }

  for (const [eventTicker, group] of byEvent.entries()) {
    if (group.length < 2) continue;

    const avgSpread = group.reduce((s, m) => s + m.spread_cents, 0) / group.length;

    for (const m of group) {
      const spreadRatio = m.spread_cents / Math.max(avgSpread, 1);
      // Flag if spread is 3x+ the group average and > 10¢ absolute
      if (spreadRatio >= 3 && m.spread_cents > 10) {
        const confidence = Math.min(1, (spreadRatio - 3) / 5);

        alerts.push({
          alert_type: "spread_anomaly",
          event_ticker: eventTicker,
          ticker_a: m.ticker,
          ticker_b: null,
          price_a_cents: m.spread_cents,
          price_b_cents: Math.round(avgSpread),
          expected_relationship: `Spread ≈ ${Math.round(avgSpread)}¢ (group average)`,
          actual_relationship: `Spread = ${m.spread_cents}¢ (${spreadRatio.toFixed(1)}x peer average)`,
          expected_edge_cents: Math.round(m.spread_cents - avgSpread),
          confidence,
          action: `${m.ticker} has anomalously wide spread (${m.spread_cents}¢ vs ${Math.round(avgSpread)}¢ avg). Use limit orders near the midpoint (${m.mid_cents}¢) to capture the spread.`,
          description: `Spread anomaly on ${m.ticker}: ${m.spread_cents}¢ spread vs ${Math.round(avgSpread)}¢ average for ${eventTicker}. Possible stale quote or thin orderbook.`,
        });
      }
    }
  }

  return alerts;
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

    const { markets: incomingMarkets, min_edge_cents = 3 } = body;

    // ── Fetch markets ─────────────────────────────────────────────────────────
    let rawMarkets: RawMarket[] = [];

    if (incomingMarkets && Array.isArray(incomingMarkets) && incomingMarkets.length > 0) {
      rawMarkets = incomingMarkets;
    } else if (supabase) {
      // Read from cache written by market-data-fetcher (runs every 5 min).
      // Never call Kalshi directly here — that's what caused the 429 rate-limit errors.
      const { data: cacheRows, error: cacheErr } = await supabase
        .from("kalshi_markets_cache")
        .select("market_data, fetched_at")
        .in("series_ticker", SERIES);

      if (cacheErr) {
        console.error("surface-scanner: cache read error:", cacheErr.message);
      }

      if (!cacheRows || cacheRows.length === 0) {
        return new Response(
          JSON.stringify({
            alerts: [],
            total_markets_scanned: 0,
            note: "Market cache is empty — market-data-fetcher has not run yet or is failing.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Warn if cache data is stale (older than 15 min) — use newest row, not oldest.
      // Old closed-market rows remain in the table indefinitely; Math.min would always
      // find one from hours ago and fire a false alarm.
      const newestMs = Math.max(...cacheRows.map((r) => new Date(r.fetched_at).getTime()));
      const ageMinutes = (Date.now() - newestMs) / 60000;
      if (ageMinutes > 15 && supabase) {
        supabase.from("compliance_log").insert({
          event_type: "cache_stale",
          severity: "warning",
          message: `surface-scanner: market cache is ${Math.round(ageMinutes)}m old — market-data-fetcher may be failing`,
          metadata: { newest_fetched_at: new Date(newestMs).toISOString() },
        }).then().catch(() => {});
      }

      for (const row of cacheRows) rawMarkets.push(row.market_data as RawMarket);
    }

    // ── Parse and deduplicate ─────────────────────────────────────────────────
    const nowMs = Date.now();
    // Exclude markets the exchange has already closed/settled — they have stale prices and
    // produce violations that S-001 will never be able to act on.
    const openRawMarkets = rawMarkets.filter((m) => {
      const s = m.status;
      return !s || s === "open" || s === "active";
    });
    const parsedRaw = openRawMarkets.map(parseMarket).filter((m): m is ParsedMarket => m !== null);
    const seen = new Set<string>();
    const markets = parsedRaw.filter((m) => {
      if (seen.has(m.ticker)) return false;
      // Skip markets that have already closed — their prices are stale and will
      // generate phantom violations that S-001 can never act on.
      if (m.close_time && new Date(m.close_time).getTime() <= nowMs) return false;
      seen.add(m.ticker);
      return true;
    });

    if (markets.length === 0) {
      return new Response(
        JSON.stringify({ alerts: [], total_markets_scanned: 0, note: "No liquid markets found to scan." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Run all detectors ─────────────────────────────────────────────────────
    const allAlerts: SurfaceAlert[] = [
      ...detectMonotonicityViolations(markets),
      ...detectBracketSumViolations(markets),
      ...detectSpreadAnomalies(markets),
    ];

    // Filter by minimum edge threshold
    const filteredAlerts = allAlerts.filter((a) => a.expected_edge_cents >= min_edge_cents);

    // Sort: highest edge first, then by confidence
    filteredAlerts.sort((a, b) => {
      if (b.expected_edge_cents !== a.expected_edge_cents)
        return b.expected_edge_cents - a.expected_edge_cents;
      return b.confidence - a.confidence;
    });

    // ── Persist alerts to surface_alerts table ────────────────────────────────
    if (supabase && filteredAlerts.length > 0) {
      const rows = filteredAlerts.map((a) => ({
        alert_type: a.alert_type,
        event_ticker: a.event_ticker,
        ticker_a: a.ticker_a,
        ticker_b: a.ticker_b,
        price_a_cents: a.price_a_cents,
        price_b_cents: a.price_b_cents,
        expected_edge_cents: a.expected_edge_cents,
        confidence: a.confidence,
        description: a.description,
        action: a.action,
        is_exploited: false,
      }));

      supabase.from("surface_alerts").insert(rows).then().catch((e: Error) => {
        console.error("Failed to persist surface alerts:", e.message);
      });

      // Purge stale alerts — rows older than 2 hours are from settled/expired events
      // and will never be tradeable. Without this the table grows forever.
      supabase.from("surface_alerts")
        .delete()
        .lt("detected_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
        .then()
        .catch((e: Error) => console.error("surface_alerts purge failed:", e.message));
    }

    // ── Log to compliance ─────────────────────────────────────────────────────
    if (supabase && filteredAlerts.length > 0) {
      supabase.from("compliance_log").insert({
        event_type: "surface_scan_complete",
        // Always "info": this is a routine completion heartbeat, not a system-health
        // signal. A high-edge detection is a trading-opportunity flag (see
        // metadata.high_edge below), not something that belongs in the same
        // severity tier as cache_stale/surface_scanner_error — those still fire at
        // warning/error elsewhere in this file and are unaffected by this change.
        severity: "info",
        message: `Surface scan found ${filteredAlerts.length} alerts across ${markets.length} markets (${allAlerts.length} total detections)`,
        metadata: {
          total_markets: markets.length,
          total_alerts: filteredAlerts.length,
          high_edge: filteredAlerts.some((a) => a.expected_edge_cents >= 10),
          by_type: {
            monotonicity: filteredAlerts.filter((a) => a.alert_type === "monotonicity_violation").length,
            bracket_sum: filteredAlerts.filter((a) => a.alert_type === "bracket_sum_violation").length,
            spread_anomaly: filteredAlerts.filter((a) => a.alert_type === "spread_anomaly").length,
          },
        },
      }).then().catch(() => {});
    }

    // ── Build response ────────────────────────────────────────────────────────
    const byType = {
      monotonicity_violations: filteredAlerts.filter((a) => a.alert_type === "monotonicity_violation"),
      bracket_sum_violations: filteredAlerts.filter((a) => a.alert_type === "bracket_sum_violation"),
      spread_anomalies: filteredAlerts.filter((a) => a.alert_type === "spread_anomaly"),
    };

    return new Response(
      JSON.stringify({
        alerts: filteredAlerts,
        by_type: byType,
        total_markets_scanned: markets.length,
        total_events_scanned: new Set(markets.map((m) => m.event_ticker)).size,
        summary: {
          total_alerts: filteredAlerts.length,
          high_confidence: filteredAlerts.filter((a) => a.confidence >= 0.6).length,
          max_edge_cents: filteredAlerts.length > 0
            ? Math.max(...filteredAlerts.map((a) => a.expected_edge_cents))
            : 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("surface-scanner error:", e);

    if (supabase) {
      supabase.from("compliance_log").insert({
        event_type: "surface_scanner_error",
        severity: "error",
        message: `Surface scanner failed: ${errMsg}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined },
      }).then().catch(() => {});

      await alertOnce(supabase, "surface_scanner_fatal", errMsg.slice(0, 60), 1,
        `🚨 <b>[TradeAgent] surface-scanner CRASHED</b>\nS-001 cross-market arbitrage detection is down — no new surface alerts will be generated.\nError: ${errMsg.slice(0, 300)}`
      ).catch(() => {});
    }

    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
