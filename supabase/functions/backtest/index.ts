import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import {
  bucketProbability,
  computeEdge,
  WEATHER_LOCATIONS,
} from "../_shared/weather.ts";

/**
 * backtest: Unified backtesting suite for all strategies.
 *
 * Query params:
 *   mode=trade_performance   — P&L / win-rate / Sharpe from settled trades
 *   mode=signal_distribution — Edge and composite score distributions (no outcome needed)
 *   mode=param_sweep         — Sweep min_edge / min_composite thresholds, count hypothetical trades
 *   mode=weather_replay      — Replay S-005 with ERA5 actuals, measure hit rate at different edge thresholds
 *   mode=signal_quality      — Win rate by source / strength / direction / ticker prefix (requires outcome_correct)
 *   mode=spread_compression  — Intraday spread patterns from weather_markets_cache (proxy for S-004 entry timing)
 *
 *   strategy=S-002|S-005|ALL (default ALL)
 *   days=30                  (lookback window, default 30, max 90)
 *
 * param_sweep extras:
 *   sweep_param=min_edge_cents|min_composite (default min_edge_cents)
 *   sweep_min=1   sweep_max=30  sweep_step=1
 *
 * Results are persisted to backtest_runs and returned in the response.
 */

const MAX_DAYS = 90;

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return json({ error: "Missing Supabase credentials" }, 500);
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "trade_performance";
  const strategyFilter = url.searchParams.get("strategy") || "ALL";
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10)));

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const params = { mode, strategy: strategyFilter, days };

  let results: any;

  try {
    switch (mode) {
      case "trade_performance":
        results = await tradePerformance(supabase, sinceStr, strategyFilter);
        break;
      case "signal_distribution":
        results = await signalDistribution(supabase, sinceStr, strategyFilter);
        break;
      case "param_sweep":
        results = await paramSweep(supabase, sinceStr, strategyFilter, url.searchParams);
        break;
      case "weather_replay":
        results = await weatherReplay(supabase, days);
        break;
      case "signal_quality":
        results = await signalQuality(supabase, sinceStr, strategyFilter);
        break;
      case "spread_compression":
        results = await spreadCompression(supabase, sinceStr);
        break;
      default:
        return json({ error: `Unknown mode: ${mode}. Valid: trade_performance, signal_distribution, param_sweep, weather_replay` }, 400);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`backtest [${mode}] error:`, errMsg);
    return json({ error: errMsg }, 500);
  }

  // Persist the run
  const runRow: any = {
    id: runId,
    strategy_id: strategyFilter,
    mode,
    params,
    results,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    triggered_by: url.searchParams.get("triggered_by") || "manual",
  };

  // Lift top-level metrics for easy querying
  if (results.summary) {
    runRow.trade_count = results.summary.trade_count ?? null;
    runRow.win_rate = results.summary.win_rate ?? null;
    runRow.avg_edge_cents = results.summary.avg_edge_cents ?? null;
    runRow.total_pnl_cents = results.summary.total_pnl_cents ?? null;
    runRow.sharpe_ratio = results.summary.sharpe_ratio ?? null;
  }

  await supabase.from("backtest_runs").insert(runRow);

  return json({ run_id: runId, mode, params, results });
});

// ─── Mode: trade_performance ──────────────────────────────────────────────────

async function tradePerformance(supabase: any, since: string, strategy: string) {
  let query = supabase
    .from("trades")
    .select("strategy_id, mode, side, price, pnl, resolution, settled_at, created_at, ticker, market_question")
    .not("settled_at", "is", null)
    .gte("created_at", since)
    .order("created_at");

  if (strategy !== "ALL") query = query.eq("strategy_id", strategy);

  const { data: trades, error } = await query;
  if (error) throw new Error(`trades query: ${error.message}`);
  if (!trades || trades.length === 0) return { summary: { trade_count: 0, message: "No settled trades in window" }, by_strategy: [] };

  // Group by strategy_id
  const groups: Record<string, any[]> = {};
  for (const t of trades) {
    const key = t.strategy_id || "unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  const byStrategy = Object.entries(groups).map(([sid, rows]) => {
    const wins = rows.filter(r => r.pnl != null && Number(r.pnl) > 0).length;
    const losses = rows.filter(r => r.pnl != null && Number(r.pnl) < 0).length;
    const pnls = rows.map(r => Number(r.pnl ?? 0));
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const meanPnl = totalPnl / pnls.length;
    const variance = pnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / pnls.length;
    const stdPnl = Math.sqrt(variance);
    const sharpe = stdPnl > 0 ? (meanPnl / stdPnl) * Math.sqrt(252) : null; // annualized, assume 1 trade/day
    const avgPrice = rows.reduce((s, r) => s + Number(r.price ?? 0), 0) / rows.length;

    // Max drawdown
    let peak = 0, maxDD = 0, running = 0;
    for (const p of pnls) {
      running += p;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      strategy_id: sid,
      trade_count: rows.length,
      wins,
      losses,
      win_rate: rows.length > 0 ? Math.round((wins / rows.length) * 1000) / 1000 : null,
      total_pnl_cents: Math.round(totalPnl * 100) / 100,
      avg_pnl_cents: Math.round(meanPnl * 100) / 100,
      avg_entry_price: Math.round(avgPrice * 10) / 10,
      sharpe_ratio: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
      max_drawdown_cents: Math.round(maxDD * 100) / 100,
      trades: rows.slice(-10).map(r => ({
        ticker: r.ticker,
        side: r.side,
        price: r.price,
        pnl: r.pnl,
        resolution: r.resolution,
        settled_at: r.settled_at,
      })),
    };
  });

  const allPnls = trades.map((r: any) => Number(r.pnl ?? 0));
  const totalPnl = allPnls.reduce((a: number, b: number) => a + b, 0);
  const wins = trades.filter((r: any) => Number(r.pnl ?? 0) > 0).length;

  return {
    summary: {
      trade_count: trades.length,
      win_rate: Math.round((wins / trades.length) * 1000) / 1000,
      total_pnl_cents: Math.round(totalPnl * 100) / 100,
      avg_pnl_cents: Math.round((totalPnl / trades.length) * 100) / 100,
      days_covered: Math.round((Date.now() - new Date(since).getTime()) / 86400000),
    },
    by_strategy: byStrategy,
  };
}

// ─── Mode: signal_distribution ───────────────────────────────────────────────

async function signalDistribution(supabase: any, since: string, strategy: string) {
  const sourceFilter = strategy === "S-005" ? "weather_signal_s005"
    : strategy === "S-002" ? "signal_generator"
    : null;

  let query = supabase
    .from("signals")
    .select("source, edge_cents, composite_score, signal_strength, direction, was_acted_on, true_probability, implied_probability, created_at")
    .gte("created_at", since);
  if (sourceFilter) query = query.eq("source", sourceFilter);

  const { data: signals, error } = await query.limit(50000);
  if (error) throw new Error(`signals query: ${error.message}`);
  if (!signals || signals.length === 0) return { summary: { total: 0, message: "No signals in window" } };

  // Distribution buckets for edge_cents
  const edgeBuckets: Record<string, number> = {};
  const compositeBuckets: Record<string, number> = {};
  let actedOn = 0;

  for (const s of signals) {
    const e = Math.floor(Number(s.edge_cents ?? 0) / 5) * 5;
    const ek = `${e}-${e + 5}c`;
    edgeBuckets[ek] = (edgeBuckets[ek] ?? 0) + 1;

    const c = Math.floor(Number(s.composite_score ?? 0) * 10) / 10;
    const ck = `${c.toFixed(1)}`;
    compositeBuckets[ck] = (compositeBuckets[ck] ?? 0) + 1;

    if (s.was_acted_on) actedOn++;
  }

  // Per-source breakdown
  const bySource: Record<string, any> = {};
  for (const s of signals) {
    const src = s.source || "unknown";
    if (!bySource[src]) bySource[src] = { count: 0, edge_sum: 0, composite_sum: 0, acted: 0 };
    bySource[src].count++;
    bySource[src].edge_sum += Number(s.edge_cents ?? 0);
    bySource[src].composite_sum += Number(s.composite_score ?? 0);
    if (s.was_acted_on) bySource[src].acted++;
  }

  const sourceStats = Object.entries(bySource).map(([src, d]: [string, any]) => ({
    source: src,
    count: d.count,
    avg_edge_cents: Math.round((d.edge_sum / d.count) * 100) / 100,
    avg_composite: Math.round((d.composite_sum / d.count) * 1000) / 1000,
    acted_on: d.acted,
    acted_rate: Math.round((d.acted / d.count) * 10000) / 10000,
  }));

  const edges = signals.map((s: any) => Number(s.edge_cents ?? 0));
  const composites = signals.map((s: any) => Number(s.composite_score ?? 0));

  return {
    summary: {
      total: signals.length,
      acted_on: actedOn,
      acted_rate: Math.round((actedOn / signals.length) * 10000) / 10000,
      avg_edge_cents: Math.round((edges.reduce((a: number, b: number) => a + b, 0) / edges.length) * 100) / 100,
      avg_composite: Math.round((composites.reduce((a: number, b: number) => a + b, 0) / composites.length) * 1000) / 1000,
      max_edge_cents: Math.max(...edges),
      p90_edge_cents: percentile(edges, 90),
      p50_edge_cents: percentile(edges, 50),
    },
    by_source: sourceStats,
    edge_distribution: Object.entries(edgeBuckets)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([bucket, count]) => ({ bucket, count })),
    composite_distribution: Object.entries(compositeBuckets)
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([bucket, count]) => ({ bucket, count })),
  };
}

// ─── Mode: param_sweep ────────────────────────────────────────────────────────

async function paramSweep(supabase: any, since: string, strategy: string, searchParams: URLSearchParams) {
  const sweepParam = searchParams.get("sweep_param") || "min_edge_cents";
  const sweepMin = parseFloat(searchParams.get("sweep_min") || "1");
  const sweepMax = parseFloat(searchParams.get("sweep_max") || "30");
  const sweepStep = parseFloat(searchParams.get("sweep_step") || "1");

  const sourceFilter = strategy === "S-005" ? "weather_signal_s005"
    : strategy === "S-002" ? "signal_generator"
    : null;

  let query = supabase
    .from("signals")
    .select("source, edge_cents, composite_score, was_acted_on, outcome_correct, outcome_pnl, true_probability, implied_probability")
    .gte("created_at", since);
  if (sourceFilter) query = query.eq("source", sourceFilter);

  const { data: signals, error } = await query.limit(100000);
  if (error) throw new Error(`signals query: ${error.message}`);
  if (!signals || signals.length === 0) return { summary: { total: 0 }, sweep: [] };

  const sweepResults = [];
  for (let threshold = sweepMin; threshold <= sweepMax; threshold += sweepStep) {
    const filtered = signals.filter((s: any) => {
      if (sweepParam === "min_edge_cents") return Number(s.edge_cents ?? 0) >= threshold;
      if (sweepParam === "min_composite") return Number(s.composite_score ?? 0) >= threshold;
      return true;
    });

    const withOutcome = filtered.filter((s: any) => s.outcome_correct !== null);
    const wins = withOutcome.filter((s: any) => s.outcome_correct === true).length;
    const edges = filtered.map((s: any) => Number(s.edge_cents ?? 0));
    const composites = filtered.map((s: any) => Number(s.composite_score ?? 0));

    sweepResults.push({
      threshold: Math.round(threshold * 100) / 100,
      signal_count: filtered.length,
      with_outcome: withOutcome.length,
      win_rate: withOutcome.length > 0 ? Math.round((wins / withOutcome.length) * 1000) / 1000 : null,
      avg_edge_cents: edges.length > 0 ? Math.round((edges.reduce((a: number, b: number) => a + b, 0) / edges.length) * 10) / 10 : null,
      avg_composite: composites.length > 0 ? Math.round((composites.reduce((a: number, b: number) => a + b, 0) / composites.length) * 1000) / 1000 : null,
    });
  }

  return {
    summary: {
      total: signals.length,
      sweep_param: sweepParam,
      sweep_range: `${sweepMin}–${sweepMax} step ${sweepStep}`,
      note: signals.filter((s: any) => s.outcome_correct !== null).length === 0
        ? "No signals have outcome_correct yet — sweep shows signal counts only"
        : undefined,
    },
    sweep: sweepResults,
  };
}

// ─── Mode: weather_replay ─────────────────────────────────────────────────────

/**
 * Replay S-005 against historical data:
 * 1. Load stored weather_forecasts from DB (these are real live forecasts from before the day resolved)
 * 2. Fetch ERA5 actual temperatures for the same dates from Open-Meteo archive
 * 3. For each forecast, re-compute bucket edge at different threshold levels
 * 4. Check whether the actual temp fell in our predicted bucket
 * 5. Compute win rate and expected value at each edge threshold
 */
async function weatherReplay(supabase: any, days: number) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // yesterday — today not yet settled
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  // 1. Load stored forecasts
  const { data: forecasts, error: fErr } = await supabase
    .from("weather_forecasts")
    .select("location, forecast_date, expected_high, std_dev, source")
    .gte("forecast_date", startStr)
    .lte("forecast_date", endStr)
    .order("forecast_date");
  if (fErr) throw new Error(`weather_forecasts: ${fErr.message}`);
  if (!forecasts || forecasts.length === 0) {
    return { summary: { message: "No stored forecasts in window", days, date_range: `${startStr} → ${endStr}` }, by_location: [] };
  }

  // 2. Load calibration
  const { data: calibRows } = await supabase
    .from("weather_calibration")
    .select("location, bias_fahrenheit, sample_count");
  const calibration = new Map<string, number>(
    (calibRows || []).filter((r: any) => (r.sample_count ?? 0) >= 5)
      .map((r: any) => [r.location, r.bias_fahrenheit ?? 0])
  );

  // 3. Fetch ERA5 actuals per location
  const locationCodes = [...new Set(forecasts.map((f: any) => f.location))] as string[];
  const era5Actuals: Record<string, Record<string, number>> = {}; // loc -> date -> actual high

  for (const code of locationCodes) {
    const loc = WEATHER_LOCATIONS.find(l => l.code === code);
    if (!loc) continue;
    try {
      const archiveParams = new URLSearchParams({
        latitude: String(loc.lat),
        longitude: String(loc.lon),
        start_date: startStr,
        end_date: endStr,
        daily: "temperature_2m_max",
        temperature_unit: "fahrenheit",
        timezone: loc.timezone,
      });
      const resp = await fetch(`https://archive-api.open-meteo.com/v1/archive?${archiveParams}`, {
        headers: { "User-Agent": "omii-ai-pm-tradeagent (operator@omii.ai)" },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const dates: string[] = data.daily?.time || [];
      const temps: (number | null)[] = data.daily?.temperature_2m_max || [];
      era5Actuals[code] = {};
      for (let i = 0; i < dates.length; i++) {
        if (temps[i] != null) era5Actuals[code][dates[i]] = temps[i]!;
      }
    } catch {
      // ERA5 unavailable for this location — skip
    }
  }

  // 4. Load weather market cache for market bucket definitions
  const { data: marketCache } = await supabase
    .from("weather_markets_cache")
    .select("ticker, location, forecast_date, bucket_low, bucket_high, yes_bid, yes_ask")
    .gte("forecast_date", startStr)
    .lte("forecast_date", endStr);

  // Group markets by location+date
  const marketsByLocDate: Record<string, any[]> = {};
  for (const m of (marketCache || [])) {
    const key = `${m.location}:${m.forecast_date}`;
    if (!marketsByLocDate[key]) marketsByLocDate[key] = [];
    marketsByLocDate[key].push(m);
  }

  // 5. Simulate trades at different edge thresholds
  const edgeThresholds = [3, 5, 8, 10, 15, 20];
  const thresholdStats: Record<number, { trades: number; wins: number; total_pnl: number; ev_sum: number }> = {};
  for (const t of edgeThresholds) thresholdStats[t] = { trades: 0, wins: 0, total_pnl: 0, ev_sum: 0 };

  const dailyResults: any[] = [];

  for (const forecast of forecasts) {
    const actual = era5Actuals[forecast.location]?.[forecast.forecast_date];
    if (actual == null) continue;

    const bias = calibration.get(forecast.location) ?? 0;
    const calibratedHigh = Math.round((Number(forecast.expected_high) - bias) * 10) / 10;
    const stdDev = Number(forecast.std_dev ?? 4);

    const markets = marketsByLocDate[`${forecast.location}:${forecast.forecast_date}`] || [];

    for (const m of markets) {
      const trueProb = bucketProbability(m.bucket_low, m.bucket_high, calibratedHigh, stdDev);
      const edge = computeEdge(m, trueProb);
      if (edge.direction === "skip") continue;

      const bucketHit = actual >= m.bucket_low && actual < m.bucket_high;
      const won = edge.direction === "buy_yes" ? bucketHit : !bucketHit;
      const pricePaid = edge.direction === "buy_yes" ? (m.yes_ask ?? 50) : (100 - (m.yes_bid ?? 50));
      const pnlCents = won ? (100 - pricePaid) : -pricePaid;

      for (const t of edgeThresholds) {
        if (Math.abs(edge.edgeCents) >= t) {
          thresholdStats[t].trades++;
          if (won) thresholdStats[t].wins++;
          thresholdStats[t].total_pnl += pnlCents;
          thresholdStats[t].ev_sum += edge.edgeCents;
        }
      }

      dailyResults.push({
        location: forecast.location,
        date: forecast.forecast_date,
        ticker: m.ticker,
        bucket: `${m.bucket_low}-${m.bucket_high}°F`,
        direction: edge.direction,
        edge_cents: Math.round(edge.edgeCents * 10) / 10,
        true_prob: Math.round(trueProb * 1000) / 1000,
        price_paid: pricePaid,
        actual_high: actual,
        bucket_hit: bucketHit,
        won,
        pnl_cents: pnlCents,
        calibrated_high: calibratedHigh,
        bias_applied: bias,
      });
    }
  }

  const sweepResults = edgeThresholds.map(t => {
    const s = thresholdStats[t];
    return {
      min_edge_cents: t,
      trades: s.trades,
      wins: s.wins,
      win_rate: s.trades > 0 ? Math.round((s.wins / s.trades) * 1000) / 1000 : null,
      total_pnl_cents: Math.round(s.total_pnl * 10) / 10,
      avg_pnl_cents: s.trades > 0 ? Math.round((s.total_pnl / s.trades) * 10) / 10 : null,
      avg_edge_cents: s.trades > 0 ? Math.round((s.ev_sum / s.trades) * 10) / 10 : null,
    };
  });

  // Per-location summary
  const locGroups: Record<string, typeof dailyResults> = {};
  for (const r of dailyResults) {
    if (!locGroups[r.location]) locGroups[r.location] = [];
    locGroups[r.location].push(r);
  }
  const byLocation = Object.entries(locGroups).map(([loc, rows]) => {
    const wins = rows.filter(r => r.won).length;
    return {
      location: loc,
      trades: rows.length,
      wins,
      win_rate: rows.length > 0 ? Math.round((wins / rows.length) * 1000) / 1000 : null,
      total_pnl_cents: Math.round(rows.reduce((s, r) => s + r.pnl_cents, 0) * 10) / 10,
    };
  });

  return {
    summary: {
      date_range: `${startStr} → ${endStr}`,
      forecasts_loaded: forecasts.length,
      days_with_era5: Object.values(era5Actuals).reduce((s, d) => s + Object.keys(d).length, 0),
      total_market_rows: dailyResults.length,
    },
    threshold_sweep: sweepResults,
    by_location: byLocation,
    recent_trades: dailyResults.slice(-20),
  };
}

// ─── Mode: signal_quality ─────────────────────────────────────────────────────

/**
 * Groups signals that have outcome_correct populated and computes win rates
 * by source, signal_strength, direction, and ticker series prefix.
 * Requires auto-settle to be writing outcome_correct back to signals.
 */
async function signalQuality(supabase: any, since: string, strategy: string) {
  const sourceMap: Record<string, string> = {
    "S-005": "weather_signal_s005",
    "S-002": "signal_generator",
  };

  let query = supabase
    .from("signals")
    .select("source, signal_strength, direction, ticker, edge_cents, composite_score, outcome_correct, outcome_pnl, created_at")
    .gte("created_at", since)
    .not("outcome_correct", "is", null);

  if (strategy !== "ALL" && sourceMap[strategy]) {
    query = query.eq("source", sourceMap[strategy]);
  }

  const { data: signals, error } = await query.limit(50000);
  if (error) throw new Error(`signals query: ${error.message}`);

  if (!signals || signals.length === 0) {
    return {
      summary: { total: 0, message: "No signals with outcome_correct yet — populate by running auto-settle on settled trades" },
      by_source: [], by_strength: [], by_direction: [], by_ticker_prefix: [],
    };
  }

  function groupStats(groups: Record<string, any[]>) {
    return Object.entries(groups).map(([key, rows]) => {
      const wins = rows.filter(r => r.outcome_correct === true).length;
      const pnls = rows.map(r => Number(r.outcome_pnl ?? 0));
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      return {
        key,
        count: rows.length,
        wins,
        win_rate: Math.round((wins / rows.length) * 1000) / 1000,
        total_pnl_cents: Math.round(totalPnl * 10) / 10,
        avg_pnl_cents: Math.round((totalPnl / rows.length) * 10) / 10,
        avg_edge_cents: Math.round(rows.reduce((s, r) => s + Number(r.edge_cents ?? 0), 0) / rows.length * 10) / 10,
      };
    }).sort((a, b) => b.count - a.count);
  }

  const bySource: Record<string, any[]> = {};
  const byStrength: Record<string, any[]> = {};
  const byDirection: Record<string, any[]> = {};
  const byPrefix: Record<string, any[]> = {};

  for (const s of signals) {
    const src = s.source || "unknown";
    const str = s.signal_strength || "unknown";
    const dir = s.direction || "unknown";
    const prefix = (s.ticker || "").split("-")[0] || "unknown";

    (bySource[src] ||= []).push(s);
    (byStrength[str] ||= []).push(s);
    (byDirection[dir] ||= []).push(s);
    (byPrefix[prefix] ||= []).push(s);
  }

  const wins = signals.filter((s: any) => s.outcome_correct === true).length;

  return {
    summary: {
      total: signals.length,
      wins,
      win_rate: Math.round((wins / signals.length) * 1000) / 1000,
    },
    by_source: groupStats(bySource),
    by_strength: groupStats(byStrength),
    by_direction: groupStats(byDirection),
    by_ticker_prefix: groupStats(byPrefix),
  };
}

// ─── Mode: spread_compression ─────────────────────────────────────────────────

/**
 * Analyzes intraday bid/ask spread patterns using weather_markets_cache
 * (fetched every 30 min by weather-signal). Shows which UTC hours have
 * the tightest spreads — the optimal entry window for weather and spread-arb
 * trades. S-004 dedicated order book history capture is a future improvement.
 */
async function spreadCompression(supabase: any, since: string) {
  const { data: rows, error } = await supabase
    .from("weather_markets_cache")
    .select("location, forecast_date, yes_bid, yes_ask, fetched_at")
    .gte("fetched_at", since)
    .not("yes_bid", "is", null)
    .not("yes_ask", "is", null)
    .limit(100000);

  if (error) throw new Error(`weather_markets_cache: ${error.message}`);

  if (!rows || rows.length === 0) {
    return {
      summary: { message: "No market cache data in window. weather-signal must run at least once to populate." },
      by_hour: [], by_location: [],
    };
  }

  const byHour: Record<number, { count: number; spread_sum: number; mid_sum: number }> = {};
  const byLoc: Record<string, { count: number; spread_sum: number }> = {};

  for (const r of rows) {
    const spread = Number(r.yes_ask) - Number(r.yes_bid);
    if (spread < 0 || spread > 100) continue;

    const hour = new Date(r.fetched_at).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { count: 0, spread_sum: 0, mid_sum: 0 };
    byHour[hour].count++;
    byHour[hour].spread_sum += spread;
    byHour[hour].mid_sum += (Number(r.yes_bid) + Number(r.yes_ask)) / 2;

    (byLoc[r.location || "unknown"] ||= { count: 0, spread_sum: 0 });
    byLoc[r.location || "unknown"].count++;
    byLoc[r.location || "unknown"].spread_sum += spread;
  }

  const hourStats = Object.entries(byHour)
    .map(([h, d]) => ({
      utc_hour: Number(h),
      observations: d.count,
      avg_spread_cents: Math.round((d.spread_sum / d.count) * 10) / 10,
      avg_mid_cents: Math.round((d.mid_sum / d.count) * 10) / 10,
    }))
    .sort((a, b) => a.utc_hour - b.utc_hour);

  const locStats = Object.entries(byLoc)
    .map(([loc, d]) => ({
      location: loc,
      observations: d.count,
      avg_spread_cents: Math.round((d.spread_sum / d.count) * 10) / 10,
    }))
    .sort((a, b) => a.avg_spread_cents - b.avg_spread_cents);

  const tightest = hourStats.reduce((best, h) =>
    h.avg_spread_cents < best.avg_spread_cents ? h : best, hourStats[0]);

  const totalSpread = rows.reduce((s: number, r: any) => s + (Number(r.yes_ask) - Number(r.yes_bid)), 0);

  return {
    summary: {
      total_observations: rows.length,
      overall_avg_spread_cents: Math.round((totalSpread / rows.length) * 10) / 10,
      tightest_hour_utc: tightest?.utc_hour,
      tightest_hour_avg_spread: tightest?.avg_spread_cents,
      note: "Data from weather_markets_cache (30-min snapshots). For S-004 non-weather spread arb, a spread_history table capturing order book per market ticker is needed.",
    },
    by_hour: hourStats,
    by_location: locStats,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
