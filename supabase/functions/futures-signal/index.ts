import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { KALSHI_BASE_URL, getKalshiCredentials, generateAuthHeaders } from "../_shared/kalshi-auth.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

const CREDENTIAL_FETCH_TIMEOUT_MS = 8_000; // same bound as market-data-fetcher/health-check/reconcile-orders/settle-signals/kalshi-ping

/**
 * futures-signal: Fed funds futures vs Kalshi KXFED cross-market oracle.
 *
 * Fetches 30-day Fed funds futures prices from Yahoo Finance (same underlying
 * contracts as CME FedWatch, accessible from cloud IPs unlike CME's website),
 * computes meeting-day implied probabilities using the standard FedWatch
 * methodology, then compares against Kalshi KXFED-* retail prices.
 *
 * When divergence exceeds 12¢, inserts a signal for the auto-trade S-001
 * FedWatch Oracle handler to consume.
 *
 * Schedule: pg_cron every 30 minutes.
 * This function never trades — it only writes signals.
 */

const MIN_DIVERGENCE_CENTS = 12;
// Set to 0 during early phases when KXFED markets have no volume yet.
// Raise to 100+ once markets develop liquidity.
const MIN_VOLUME = 0;

// Current Fed funds target range in basis points.
// Update after each FOMC decision. Last updated: post-Dec 2024 cut.
// 4.25-4.50% target range → midpoint 437.5bps used for math.
const CURRENT_RATE_LOWER_BPS = 425;
const CURRENT_RATE_UPPER_BPS = 450;
const CURRENT_RATE_MID_BPS = (CURRENT_RATE_LOWER_BPS + CURRENT_RATE_UPPER_BPS) / 2; // 437.5

// Yahoo Finance month codes for CBOT 30-day Fed funds futures (ZQ[code][YY].CBT)
const YAHOO_MONTH_CODES = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];

function getYahooTicker(year: number, month: number): string {
  const code = YAHOO_MONTH_CODES[month - 1];
  const yy = String(year).slice(2);
  return `ZQ${code}${yy}.CBT`;
}

async function fetchFuturesPrice(ticker: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OmiiAgent/1.0)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

// Compute implied post-meeting rate from the monthly futures price.
// FedWatch methodology: futures_implied_avg = ((D-1)*pre + (N-D+1)*post) / N
// where D = meeting day (1-indexed), N = days in month.
// Solving for post_rate: post = (implied*N - (D-1)*pre) / (N-D+1)
function computeImpliedPostRateBps(
  futuresPrice: number,
  meetingDay: number,
  daysInMonth: number,
  preRateMidBps: number,
): number {
  const impliedRateBps = (100 - futuresPrice) * 100; // futures 96.375 → implied 3.625% → 362.5 bps
  const daysBeforeMeeting = meetingDay - 1;
  const daysFromMeetingToMonthEnd = daysInMonth - meetingDay + 1;

  if (daysFromMeetingToMonthEnd <= 0) return preRateMidBps;

  return (impliedRateBps * daysInMonth - preRateMidBps * daysBeforeMeeting)
    / daysFromMeetingToMonthEnd;
}

// Compute probability distribution over Kalshi KXFED upper-bound levels.
//
// Kalshi KXFED markets ask "will the upper bound be exactly R%?", meaning
// the Fed set the target range to [R-0.25%, R%] with EFFR midpoint = R - 12.5bps.
//
// Given futures-implied EFFR (a point estimate), we interpolate across the two
// adjacent Kalshi upper-bound levels whose target-range midpoints bracket the
// implied EFFR.
//
// For implied = 354bps and outcomes at 350 (midpoint 337.5) and 375 (midpoint 362.5):
//   P(upper=375) = (354 - 337.5) / 25 = 66%
//   P(upper=350) = (362.5 - 354) / 25 = 34%
function computeProbabilities(impliedPostBps: number): Map<number, number> {
  const probs = new Map<number, number>();

  // Find the Kalshi upper-bound level R such that R's midpoint is just above implied:
  // R - 12.5 >= implied → R >= implied + 12.5 → R = ceil((implied+12.5)/25)*25
  const upperR = Math.ceil((impliedPostBps + 12.5) / 25) * 25;
  const lowerR = upperR - 25;

  // Midpoints of each target range
  const upperMid = upperR - 12.5;
  const lowerMid = lowerR - 12.5;

  // Linear interpolation between midpoints
  const pUpper = (impliedPostBps - lowerMid) / (upperMid - lowerMid);
  const pLower = 1 - pUpper;

  if (pUpper > 0.005) probs.set(upperR, pUpper);
  if (pLower > 0.005) probs.set(lowerR, pLower);

  return probs;
}

const MONTH_ABBR: Record<string, number> = {
  JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6,
  JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12,
};

// Parse KXFED ticker in Kalshi's actual format: KXFED-{YY}{MMM}-T{rate}
// e.g. KXFED-26JUN-T4.25 → { year: 2026, month: 6, rateBps: 425, yyMM: "2606" }
function parseKXFEDTicker(ticker: string): { year: number; month: number; rateBps: number; yyMM: string } | null {
  const m = ticker.match(/^KXFED-(\d{2})([A-Z]{3})-T([\d.]+)$/i);
  if (!m) return null;
  const year = 2000 + parseInt(m[1], 10);
  const month = MONTH_ABBR[m[2].toUpperCase()];
  if (!month) return null;
  const rateNum = parseFloat(m[3]);
  if (isNaN(rateNum)) return null;
  const rateBps = rateNum > 10 ? Math.round(rateNum) : Math.round(rateNum * 100);
  const yyMM = `${m[1]}${String(month).padStart(2, "0")}`;
  return { year, month, rateBps, yyMM };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getDate(); // month is 1-based
}

function daysUntilDate(year: number, month: number, day: number): number {
  const target = Date.UTC(year, month - 1, day);
  return (target - Date.now()) / (1000 * 60 * 60 * 24);
}

const toCents = (v: any): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return n > 1 ? Math.round(n) : Math.round(n * 100);
};

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({ error: "Missing Supabase credentials" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const runId = crypto.randomUUID();
  const runStartedAt = new Date().toISOString();

  // ── 1. Fetch open KXFED-* markets from Kalshi (used to discover meeting months) ──
  // We fetch markets first, extract meeting months from close_time, then fetch futures prices.
  let kalshiMarkets: any[] = [];
  try {
    // Same anonymous-rate-tier issue fixed in kalshi-proxy/trading-agent
    // (2026-07-26): sign with the service-tenant credential when available.
    let kalshiHeaders: Record<string, string> = { "Accept": "application/json" };
    // Bare `await` here would hang this whole try block forever on a stalled
    // query — same class of unguarded-credential-fetch bug fixed in
    // market-data-fetcher/health-check/reconcile-orders/settle-signals/kalshi-ping.
    // The outer catch below only fires on a *thrown* error, so an indefinite
    // hang would never reach it and this cron run (every 10 min) would stall.
    let serviceKeyId: string | null, servicePrivateKey: string | null;
    {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`credential fetch exceeded ${CREDENTIAL_FETCH_TIMEOUT_MS}ms`)),
          CREDENTIAL_FETCH_TIMEOUT_MS
        );
      });
      try {
        const creds = await Promise.race([getKalshiCredentials(supabase, null), timeout]);
        serviceKeyId = creds.keyId;
        servicePrivateKey = creds.privateKey;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    if (serviceKeyId && servicePrivateKey) {
      kalshiHeaders = {
        ...kalshiHeaders,
        ...(await generateAuthHeaders(serviceKeyId, servicePrivateKey, "GET", "/trade-api/v2/markets", Date.now())),
      };
    }
    const kalshiResp = await fetch(
      `${KALSHI_BASE_URL}/markets?limit=200&status=open&series_ticker=KXFED`,
      { headers: kalshiHeaders, signal: AbortSignal.timeout(10_000) }
    );
    if (kalshiResp.ok) {
      const kalshiData = await kalshiResp.json().catch(() => ({}));
      kalshiMarkets = kalshiData.markets || [];
    }
  } catch (e) {
    console.warn("Kalshi KXFED fetch failed:", e instanceof Error ? e.message : e);
  }

  if (kalshiMarkets.length === 0) {
    // Count consecutive misses — alert on the 5th (fed markets missing for ~50 min is a data problem, not normal).
    const fiftyMinAgo = new Date(Date.now() - 55 * 60 * 1000).toISOString();
    const { count: missCount } = await supabase
      .from("compliance_log")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "futures_signal_run")
      .eq("severity", "warning")
      .gte("created_at", fiftyMinAgo);

    const consecutiveMisses = (missCount ?? 0) + 1;

    await supabase.from("compliance_log").insert({
      event_type: "futures_signal_run",
      severity: "warning",
      message: `futures-signal: No open KXFED markets found on Kalshi (miss #${consecutiveMisses})`,
      metadata: { run_id: runId, consecutive_misses: consecutiveMisses },
    });

    if (consecutiveMisses === 5) {
      await sendTelegramAlert(
        `⚠️ <b>[TradeAgent] Futures Signal Feed Down</b>\n` +
        `No open KXFED markets on Kalshi for ${consecutiveMisses} consecutive runs (~50 min).\n` +
        `Fed rate signals are not flowing. Check Kalshi API and market availability.`
      ).catch(() => {});
    }

    return new Response(
      JSON.stringify({ success: false, reason: "No KXFED markets on Kalshi", consecutive_misses: consecutiveMisses }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ── 2. Build meeting month map from two sources ───────────────────────────────
  // Source A: Kalshi KXFED market close_times (authoritative when available)
  // Source B: Hardcoded FOMC calendar (fills gaps for months with no Kalshi market,
  //           e.g. KXFED-26MAY doesn't exist but the May meeting still happened
  //           and must be in the chain or June's pre-rate is wrong)
  //
  // The rate chain only moves at FOMC meetings. Skipping a meeting with no Kalshi
  // market causes all subsequent meeting probabilities to be wildly wrong because
  // the pre-rate carries forward as if no cut happened.
  const FOMC_CALENDAR: Record<string, number> = {
    // key: "YYMM", value: decision day of month (UTC)
    "2601": 29, "2603": 19, "2604": 30, "2605": 7,  "2606": 18,
    "2607": 30, "2609": 16, "2611": 5,  "2612": 10,
    "2701": 29, "2703": 18, "2704": 30, "2706": 17,
  };

  const meetingMonthsMap = new Map<string, { year: number; month: number; meetingDay: number }>();

  // Seed from FOMC calendar first (lower priority — Kalshi data overrides)
  for (const [yyMM, day] of Object.entries(FOMC_CALENDAR)) {
    const year = 2000 + parseInt(yyMM.slice(0, 2), 10);
    const month = parseInt(yyMM.slice(2, 4), 10);
    const daysLeft = (Date.UTC(year, month - 1, day) - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft >= 2) { // skip past meetings and meetings in <2 days
      meetingMonthsMap.set(yyMM, { year, month, meetingDay: day });
    }
  }

  // Override with actual Kalshi close_times where available (more accurate)
  for (const market of kalshiMarkets) {
    const parsed = parseKXFEDTicker(market.ticker || "");
    if (!parsed) continue;
    const closeTime = market.close_time || market.expiration_time || "";
    if (!closeTime) continue;
    const closeDate = new Date(closeTime);
    if (isNaN(closeDate.getTime())) continue;
    const daysLeft = (closeDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 2) {
      meetingMonthsMap.delete(parsed.yyMM); // remove calendar entry too — meeting is imminent
      continue;
    }
    meetingMonthsMap.set(parsed.yyMM, {
      year: parsed.year,
      month: parsed.month,
      meetingDay: closeDate.getUTCDate(),
    });
  }

  // ── 3. Fetch futures prices for every month from now to farthest meeting ──────
  // We need ALL intermediate months (not just meeting months) to chain the
  // implied rate path correctly. FedWatch uses the prior month's contract to
  // establish the pre-meeting rate for each meeting's probability calculation.
  const now = new Date();
  const fetchLog: any[] = [];
  const allMonthPrices = new Map<string, number>(); // yyMM → futures price

  // Determine the range of months to fetch
  const sortedMeetingKeys = [...meetingMonthsMap.keys()].sort();
  const lastKey = sortedMeetingKeys[sortedMeetingKeys.length - 1]; // e.g. "2704"
  const lastYear = 2000 + parseInt(lastKey.slice(0, 2), 10);
  const lastMonth = parseInt(lastKey.slice(2, 4), 10);

  const monthsToFetch: Array<{ year: number; month: number; yyMM: string }> = [];
  let fetchYear = now.getUTCFullYear();
  let fetchMonth = now.getUTCMonth() + 1; // current month
  while (fetchYear < lastYear || (fetchYear === lastYear && fetchMonth <= lastMonth)) {
    const yy = String(fetchYear).slice(2);
    const mm = String(fetchMonth).padStart(2, "0");
    monthsToFetch.push({ year: fetchYear, month: fetchMonth, yyMM: `${yy}${mm}` });
    fetchMonth++;
    if (fetchMonth > 12) { fetchMonth = 1; fetchYear++; }
  }

  await Promise.all(monthsToFetch.map(async ({ year, month, yyMM }) => {
    const ticker = getYahooTicker(year, month);
    const price = await fetchFuturesPrice(ticker);
    if (price !== null) {
      allMonthPrices.set(yyMM, price);
      fetchLog.push({ ticker, yyMM, futures_price: price });
    } else {
      fetchLog.push({ ticker, yyMM, error: "no price" });
    }
  }));

  // ── 4. Build implied rate chain and compute meeting probabilities ─────────────
  // Chain: start from current rate, propagate implied post-meeting rates forward.
  // For each month M with a futures price:
  //   implied_avg = (100 - futures_price) * 100 bps
  //   If month M has a meeting on day D:
  //     pre_rate = chain_rate (carried forward from previous meeting)
  //     post_rate = computeImpliedPostRateBps(futures_price, D, N, pre_rate)
  //     → probabilities from (post_rate, pre_rate)
  //     → update chain_rate = max(0, post_rate) for next segment
  //   Else (no meeting): chain_rate ≈ implied_avg for that month
  const meetingData = new Map<string, { futuresPrice: number; probs: Map<number, number>; meetingDay: number; preRateBps: number }>();

  // Bootstrap chainRateBps from the nearest available futures price.
  // CURRENT_RATE_MID_BPS is a stale fallback (last set Dec 2024). The current month's
  // ZQ contract gives the actual current rate: since most of the month has elapsed at
  // the current rate and the April meeting is imminent, the April futures price ≈ current rate.
  const nowYY = String(now.getUTCFullYear()).slice(2);
  const nowMM = String(now.getUTCMonth() + 1).padStart(2, "0");
  const nowKey = `${nowYY}${nowMM}`;
  const bootstrapPrice = allMonthPrices.get(nowKey);
  let chainRateBps = bootstrapPrice != null
    ? (100 - bootstrapPrice) * 100  // derive from live futures
    : CURRENT_RATE_MID_BPS;         // hardcoded fallback if Yahoo failed

  const allMonths = monthsToFetch.map(m => m.yyMM).sort();
  for (const yyMM of allMonths) {
    const price = allMonthPrices.get(yyMM);
    if (!price) continue;

    const impliedAvgBps = (100 - price) * 100;
    const meetingMeta = meetingMonthsMap.get(yyMM);

    if (meetingMeta) {
      // This month has a FOMC meeting
      const nim = daysInMonth(meetingMeta.year, meetingMeta.month);
      const impliedPost = computeImpliedPostRateBps(price, meetingMeta.meetingDay, nim, chainRateBps);
      // Clamp to reasonable range (no more than 200bps change per meeting)
      const clampedPost = Math.max(chainRateBps - 200, Math.min(chainRateBps + 100, impliedPost));
      const probs = computeProbabilities(clampedPost);

      meetingData.set(yyMM, { futuresPrice: price, probs, meetingDay: meetingMeta.meetingDay, preRateBps: chainRateBps });
      fetchLog.find(f => f.yyMM === yyMM && !f.error)!.implied_post_rate_bps = Math.round(clampedPost);
      fetchLog.find(f => f.yyMM === yyMM && !f.error)!.pre_rate_bps = Math.round(chainRateBps);
      fetchLog.find(f => f.yyMM === yyMM && !f.error)!.probabilities =
        Object.fromEntries([...probs.entries()].map(([k, v]) => [`${k}bps`, (v * 100).toFixed(1) + "%"]));

      // Update chain to post-meeting rate for next segment
      chainRateBps = Math.max(0, clampedPost);
    } else {
      // No meeting this month — chain rate is unchanged. Fed funds rates only change
      // at FOMC meetings. Using the monthly futures average here was a bug: it would
      // set chainRateBps to the post-cut implied average, making subsequent meetings
      // use the wrong pre-rate and producing wildly inflated edge signals.
    }
  }

  if (meetingData.size === 0) {
    await supabase.from("compliance_log").insert({
      event_type: "futures_signal_run",
      severity: "warning",
      message: "futures-signal: Could not fetch any futures prices from Yahoo Finance",
      metadata: { run_id: runId, fetch_log: fetchLog },
    });
    return new Response(
      JSON.stringify({ success: false, reason: "Yahoo Finance returned no prices", fetch_log: fetchLog }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ── 5. Match Kalshi markets to futures-implied probabilities ─────────────────
  const signalsToInsert: any[] = [];
  const evaluated: any[] = [];

  for (const market of kalshiMarkets) {
    const ticker: string = market.ticker || "";
    const parsed = parseKXFEDTicker(ticker);
    if (!parsed) continue;

    const { yyMM, rateBps } = parsed;
    const mtgData = meetingData.get(yyMM);
    if (!mtgData) {
      evaluated.push({ ticker, skip_reason: `no futures data for month ${yyMM}` });
      continue;
    }

    // Kalshi KXFED-T{R} question: "Will the upper bound be ABOVE R%?"
    // = P(post-meeting rate > rateBps) = cumulative sum of all outcome probs above rateBps.
    // Bug fixed: previously used exact-match mtgData.probs.get(rateBps) which gave P(rate = R),
    // but Kalshi sells YES on whether the rate EXCEEDS R, not equals R.
    const futuresProb = [...mtgData.probs.entries()]
      .filter(([rBps]) => rBps > rateBps)
      .reduce((sum, [, prob]) => sum + prob, 0);

    // Skip if both outcomes are near-certain (no edge possible) or data is degenerate
    if (futuresProb < 0.005 && (1 - futuresProb) < 0.005) {
      evaluated.push({
        ticker,
        skip_reason: `degenerate prob for above ${rateBps}bps`,
        available_outcomes: [...mtgData.probs.entries()].map(([k, v]) => `${k}bps:${(v*100).toFixed(1)}%`),
      });
      continue;
    }

    const yesBid = toCents(market.yes_bid_dollars ?? market.yes_bid);
    const yesAsk = toCents(market.yes_ask_dollars ?? market.yes_ask);
    const volume = Math.round(parseFloat(market.volume_fp || market.volume_24h_fp || market.volume || market.volume_24h || "0") || 0);
    const title: string = market.title || market.subtitle || ticker;

    if (yesBid === null || yesAsk === null) {
      evaluated.push({ ticker, skip_reason: "no bid/ask" });
      continue;
    }

    if (volume < MIN_VOLUME) {
      evaluated.push({ ticker, skip_reason: `volume ${volume} < ${MIN_VOLUME}` });
      continue;
    }

    const midCents = Math.round((yesBid + yesAsk) / 2);
    const kalshiDecimal = midCents / 100;
    const divergenceCents = Math.round(Math.abs(futuresProb - kalshiDecimal) * 100);

    evaluated.push({
      ticker,
      futures_prob_pct: (futuresProb * 100).toFixed(1),
      kalshi_mid_cents: midCents,
      divergence_cents: divergenceCents,
      volume,
    });

    if (divergenceCents < MIN_DIVERGENCE_CENTS) continue;

    const direction = futuresProb > kalshiDecimal ? "buy_yes" : "buy_no";

    signalsToInsert.push({
      ticker,
      market_question: title,
      direction,
      signal_strength: divergenceCents >= 20 ? "strong" : divergenceCents >= 15 ? "moderate" : "weak",
      yes_bid: yesBid,
      yes_ask: yesAsk,
      mid_price: midCents,
      edge_cents: divergenceCents,
      days_to_close: parseFloat(daysUntilDate(
        2000 + parseInt(yyMM.slice(0, 2), 10),
        parseInt(yyMM.slice(2, 4), 10),
        mtgData.meetingDay,
      ).toFixed(2)),
      volume,
      composite_score: parseFloat(Math.min(1, divergenceCents / 30).toFixed(3)),
      liquidity_score: parseFloat(Math.min(1, volume / 1000).toFixed(3)),
      true_probability: parseFloat(futuresProb.toFixed(4)),
      implied_probability: parseFloat(kalshiDecimal.toFixed(4)),
      source: "futures_oracle",
      metadata: {
        yyMM,
        outcome_rate_bps: rateBps,
        futures_price: mtgData.futuresPrice,
        futures_source: "yahoo_finance_zq_futures",
        run_id: runId,
      },
    });
  }

  // ── 5. Insert signals ─────────────────────────────────────────────────────────
  let insertedCount = 0;
  if (signalsToInsert.length > 0) {
    const { error: insertErr } = await supabase.from("signals").insert(signalsToInsert);
    if (insertErr) {
      console.error("futures-signal insert error:", insertErr.message);
    } else {
      insertedCount = signalsToInsert.length;
    }
  }

  // ── 6. Log run ────────────────────────────────────────────────────────────────
  await supabase.from("compliance_log").insert({
    event_type: "futures_signal_run",
    severity: "info",
    message: `futures-signal: ${insertedCount} signal(s) inserted from ${kalshiMarkets.length} KXFED markets, ${meetingData.size} futures months`,
    metadata: {
      run_id: runId,
      started_at: runStartedAt,
      fetch_log: fetchLog,
      kalshi_markets: kalshiMarkets.length,
      evaluated,
      signals_inserted: insertedCount,
    },
  });

  return new Response(
    JSON.stringify({
      success: true,
      run_id: runId,
      futures_months_fetched: meetingData.size,
      kalshi_markets: kalshiMarkets.length,
      signals_inserted: insertedCount,
      fetch_log: fetchLog,
      evaluated,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
