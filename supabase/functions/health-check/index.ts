import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

/**
 * health-check: Monitors the trading agent and alerts via Telegram.
 *
 * Deduplication: each alert type has a fingerprint (captures what condition
 * is detected) and a cooldown window. An alert only fires if the same
 * fingerprint has NOT been sent within the cooldown period. This prevents
 * hourly spam for persistent conditions while still paging on new ones.
 *
 * Alert types and their re-alert cadence:
 *   trading_silence   — once per 4h bucket (re-alerts at 8h, 12h, 16h…)
 *   win_rate_collapse — once per unique W/L count per 24h
 *   volume_spike      — once per 1h
 *   blocked_series    — once per unique ticker set per 1h
 *   strategy_suspended — once per unique strategy set per 6h
 *   system_errors     — once per unique error message per 2h
 *   rate_limits       — once per unique series set per 2h
 */

const SILENCE_HOURS = 24;
const WIN_RATE_FLOOR = 0.60;
const WIN_RATE_SAMPLE = 20;
const VOLUME_SPIKE_MULTIPLIER = 8; // only alert on genuine runaway loops, not manual burst sessions
const BLOCKED_SERIES = ["KXETH"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendTelegram(token: string, chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  return resp.ok;
}

// Returns true if we should SKIP sending this alert (already sent same fingerprint within cooldown).
// Uses compliance_log as state store — no new tables needed.
async function isDuped(
  supabase: any,
  alertType: string,
  fingerprint: string,
  cooldownHours: number
): Promise<boolean> {
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("compliance_log")
    .select("id")
    .eq("event_type", "health_check_alert")
    .eq("metadata->>alert_type", alertType)
    .eq("metadata->>fingerprint", fingerprint)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();
  return !!data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!supabaseUrl || !supabaseKey) return json({ error: "Missing Supabase credentials" }, 500);
  if (!telegramToken || !telegramChatId) return json({ error: "Missing Telegram credentials" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey);
  // Each entry: { type, fingerprint, cooldownHours, message }
  const pendingAlerts: { type: string; fingerprint: string; cooldownHours: number; message: string }[] = [];
  const now = new Date();

  try {
    // ── 1. Trading silence check ─────────────────────────────────────
    const { data: lastTrade } = await supabase
      .from("trades")
      .select("created_at, strategy_id")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: activeStrategies } = await supabase
      .from("strategies")
      .select("id, name, active, suspended_until")
      .eq("active", true);

    const { data: recentSignals } = await supabase
      .from("signals")
      .select("id")
      .gte("created_at", new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())
      .limit(1);

    const hasActiveStrategies = (activeStrategies || []).some(
      (s) => !s.suspended_until || new Date(s.suspended_until) < now
    );
    const hasSignals = (recentSignals || []).length > 0;

    if (hasActiveStrategies && hasSignals) {
      const lastTradeTime = lastTrade ? new Date(lastTrade.created_at) : null;
      const hoursSinceLastTrade = lastTradeTime
        ? (now.getTime() - lastTradeTime.getTime()) / (1000 * 60 * 60)
        : 999;

      if (hoursSinceLastTrade >= SILENCE_HOURS) {
        // One alert per calendar day — fingerprint on today's UTC date so the
        // same silence condition never fires more than once in a 24h window.
        const fingerprint = `silence_day_${now.toISOString().slice(0, 10)}`;
        const sinceStr = lastTradeTime
          ? `${hoursSinceLastTrade.toFixed(1)}h ago (${lastTradeTime.toISOString().slice(0, 16)} UTC)`
          : "never";
        pendingAlerts.push({
          type: "trading_silence",
          fingerprint,
          cooldownHours: SILENCE_HOURS,
          message:
            `⚠️ <b>[TradeAgent] Trading Silence</b>\n` +
            `No trades placed in ${hoursSinceLastTrade.toFixed(1)}h.\n` +
            `Last trade: ${sinceStr}\n` +
            `Strategies active: ${[...new Set((activeStrategies || []).map((s: any) => s.name))].join(", ")}\n` +
            `Signals present: yes — check compliance_log for errors.`,
        });
      }
    }

    // ── 2. Win rate collapse check ────────────────────────────────────
    const { data: recentSettled } = await supabase
      .from("trades")
      .select("pnl, strategy_id")
      .not("settled_at", "is", null)
      .not("pnl", "is", null)
      .order("settled_at", { ascending: false })
      .limit(WIN_RATE_SAMPLE);

    if (recentSettled && recentSettled.length >= 10) {
      const wins = recentSettled.filter((t: any) => Number(t.pnl) > 0).length;
      const losses = recentSettled.length - wins;
      const winRate = wins / recentSettled.length;
      if (winRate < WIN_RATE_FLOOR) {
        // Fingerprint includes the exact W/L count — a new alert fires only if
        // the numbers actually change (new trades settle with a different outcome).
        // Same 11W/9L sitting for days → one alert per 24h max.
        const fingerprint = `winrate_${wins}W${losses}L_of${recentSettled.length}`;
        pendingAlerts.push({
          type: "win_rate_collapse",
          fingerprint,
          cooldownHours: 24,
          message:
            `🔴 <b>[TradeAgent] Win Rate Collapse</b>\n` +
            `Last ${recentSettled.length} settled trades: ${wins}W/${losses}L (${(winRate * 100).toFixed(1)}% — floor is ${(WIN_RATE_FLOOR * 100).toFixed(0)}%)\n` +
            `Review recent signals and strategy filters.`,
        });
      }
    }

    // ── 3. Volume spike check ─────────────────────────────────────────
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const { count: lastHourCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .gte("created_at", oneHourAgo);

    const { count: priorDayCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .gte("created_at", twentyFourHoursAgo)
      .lt("created_at", oneHourAgo);

    const priorHourlyAvg = (priorDayCount ?? 0) / 23;
    if ((lastHourCount ?? 0) > 15 && priorHourlyAvg > 0 && (lastHourCount ?? 0) > priorHourlyAvg * VOLUME_SPIKE_MULTIPLIER) {
      // Fingerprint on the current hour so the same spike doesn't re-alert within 1h.
      const fingerprint = `spike_${now.toISOString().slice(0, 13)}`;
      pendingAlerts.push({
        type: "volume_spike",
        fingerprint,
        cooldownHours: 1,
        message:
          `🚨 <b>[TradeAgent] Volume Spike</b>\n` +
          `Last hour: ${lastHourCount} trades\n` +
          `Prior 23h hourly avg: ${priorHourlyAvg.toFixed(1)}\n` +
          `Ratio: ${((lastHourCount ?? 0) / priorHourlyAvg).toFixed(1)}x — check cron schedule and strategy loop.`,
      });
    }

    // ── 4. Duplicate open positions check ────────────────────────────
    // Detects the exit-loop failure mode: same (user_id, ticker) with >2 open
    // filled trades means an exit ran but failed to tombstone the original.
    const { data: openPositions } = await supabase
      .from("trades")
      .select("ticker, user_id")
      .eq("status", "filled")
      .is("settled_at", null)
      .is("exit_reason", null);

    const positionCounts = new Map<string, number>();
    for (const t of openPositions ?? []) {
      const key = `${(t as any).user_id}::${(t as any).ticker}`;
      positionCounts.set(key, (positionCounts.get(key) ?? 0) + 1);
    }
    const duplicateEntries = [...positionCounts.entries()].filter(([, n]) => n > 2);
    if (duplicateEntries.length > 0) {
      const tickerList = [...new Set(duplicateEntries.map(([k]) => k.split("::")[1]))].sort();
      // Fingerprint on the sorted ticker set — same set within 1h = 1 alert.
      const fingerprint = `dupes_${tickerList.join(",")}`;
      pendingAlerts.push({
        type: "duplicate_positions_detected",
        fingerprint,
        cooldownHours: 1,
        message:
          `🔄 <b>[TradeAgent] Duplicate Open Positions</b>\n` +
          `${duplicateEntries.length} (user, ticker) pair(s) with >2 open filled rows.\n` +
          `Tickers: ${tickerList.join(", ")}\n` +
          `Exit loop may be running — check that tombstone UPDATE fires after each exit order in auto-trade.`,
      });
    }

    // ── 6. Blocked series check ───────────────────────────────────────
    const { data: blockedTrades } = await supabase
      .from("trades")
      .select("ticker, strategy_id, created_at")
      .gte("created_at", oneHourAgo)
      .limit(100);

    const violations = (blockedTrades ?? []).filter((t: any) =>
      BLOCKED_SERIES.some(prefix => (t.ticker as string).startsWith(prefix))
    );
    if (violations.length > 0) {
      const sample = violations.slice(0, 3).map((t: any) => t.ticker).join(", ");
      // Fingerprint on the sorted ticker set — same violation within 1h = 1 alert.
      const fingerprint = `blocked_${[...new Set(violations.map((t: any) => t.ticker))].sort().join(",")}`;
      pendingAlerts.push({
        type: "blocked_series",
        fingerprint,
        cooldownHours: 1,
        message:
          `🚫 <b>[TradeAgent] Blocked Series Trading</b>\n` +
          `${violations.length} trade(s) on blocked series in last hour.\n` +
          `Sample: ${sample}\n` +
          `Blocked series: ${BLOCKED_SERIES.join(", ")} — fix ALLOWED_PREFIXES in auto-trade immediately.`,
      });
    }

    // ── 7. Suspended strategy check ───────────────────────────────────
    const suspended = (activeStrategies ?? []).filter(
      (s: any) => s.suspended_until && new Date(s.suspended_until) > now
    );
    if (suspended.length > 0) {
      // Fingerprint on sorted strategy IDs — same strategies suspended = 1 alert per 6h.
      const fingerprint = `suspended_${suspended.map((s: any) => s.id).sort().join(",")}`;
      pendingAlerts.push({
        type: "strategy_suspended",
        fingerprint,
        cooldownHours: 6,
        message:
          `⏸️ <b>[TradeAgent] Strategy Suspended</b>\n` +
          suspended.map((s: any) =>
            `${s.name}: suspended until ${new Date(s.suspended_until).toISOString().slice(0, 16)} UTC`
          ).join("\n"),
      });
    }

    // ── 8. Compliance log errors + 429s (last 2h) ────────────────────
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

    const { data: recentErrors } = await supabase
      .from("compliance_log")
      .select("event_type, severity, message, created_at")
      .in("severity", ["error", "critical"])
      .gte("created_at", twoHoursAgo)
      .order("created_at", { ascending: false })
      .limit(10);

    if (recentErrors && recentErrors.length > 0) {
      const sample = recentErrors.slice(0, 3)
        .map((e: any) => `• ${e.event_type}: ${e.message.slice(0, 80)}`)
        .join("\n");
      // Fingerprint on the first error message so the same repeated error doesn't spam.
      const fingerprint = `errors_${recentErrors[0].event_type}_${recentErrors[0].message.slice(0, 60)}`;
      pendingAlerts.push({
        type: "system_errors",
        fingerprint,
        cooldownHours: 2,
        message:
          `🔴 <b>[TradeAgent] System Errors (last 2h)</b>\n` +
          `${recentErrors.length} error/critical event(s):\n${sample}`,
      });
    }

    // Structured API error sweep — covers all providers + all HTTP status codes.
    // Uses event_type filter (structured) instead of text-match on message — eliminates
    // false positives from messages that contain status codes as substrings (e.g. "14297m old").
    const API_ERROR_TYPES = ["api_error", "llm_rate_limit", "api_timeout", "kalshi_circuit_open"];
    const extractProvider = (row: any): string => {
      if (row.metadata?.provider) return row.metadata.provider;
      const ep: string = row.metadata?.endpoint || row.metadata?.full_path || "";
      if (/openrouter/i.test(ep)) return "openrouter";
      if (/anthropic/i.test(ep)) return "anthropic";
      if (/openai/i.test(ep)) return "openai";
      if (/kalshi|trade-api|markets/i.test(ep)) return "kalshi";
      const msg: string = row.message || "";
      if (/openrouter/i.test(msg)) return "openrouter";
      if (/anthropic/i.test(msg)) return "anthropic";
      if (/openai/i.test(msg)) return "openai";
      if (/kalshi/i.test(msg)) return "kalshi";
      if (row.event_type === "kalshi_circuit_open") return "kalshi";
      return "unknown";
    };

    const { data: apiErrors } = await supabase
      .from("compliance_log")
      .select("event_type, message, metadata, created_at")
      .in("event_type", API_ERROR_TYPES)
      .gte("created_at", twoHoursAgo)
      .order("created_at", { ascending: false })
      .limit(200);

    const errorMap = new Map<string, { count: number; message: string }>();
    for (const row of apiErrors ?? []) {
      const status = row.metadata?.status ?? row.metadata?.http_status ?? row.event_type;
      const provider = extractProvider(row);
      const key = `${provider}:${status}`;
      const existing = errorMap.get(key);
      if (!existing) {
        errorMap.set(key, { count: 1, message: row.message });
      } else {
        existing.count++;
      }
    }

    for (const [key, info] of errorMap.entries()) {
      const [provider, status] = key.split(":");
      const isRateLimit = String(status) === "429" || status === "llm_rate_limit";
      pendingAlerts.push({
        type: `api_error_${provider}`,
        fingerprint: `api_error_${key}`,
        cooldownHours: 2,
        message:
          `🔴 <b>[TradeAgent] ${provider.toUpperCase()} ${isRateLimit ? "Rate Limited (429)" : `HTTP ${status}`}</b>\n` +
          `${info.count} hit(s) in last 2h\n` +
          `${info.message.slice(0, 120)}`,
      });
    }

    // ── Deduplicate and send ──────────────────────────────────────────
    // For each pending alert, check compliance_log to see if the same fingerprint
    // was already sent within the cooldown window. Only send new or escalating alerts.
    const alertsSent: string[] = [];
    const alertsSkipped: string[] = [];

    for (const alert of pendingAlerts) {
      const skip = await isDuped(supabase, alert.type, alert.fingerprint, alert.cooldownHours);
      if (skip) {
        alertsSkipped.push(alert.type);
        continue;
      }

      await sendTelegram(telegramToken, telegramChatId, alert.message);

      // Record this send so future runs can deduplicate against it.
      await supabase.from("compliance_log").insert({
        event_type: "health_check_alert",
        severity: "warning",
        message: `Alert sent: ${alert.type}`,
        metadata: { alert_type: alert.type, fingerprint: alert.fingerprint },
      });

      alertsSent.push(alert.type);
    }

    // Log the run result — distinguish sent vs suppressed.
    await supabase.from("compliance_log").insert({
      event_type: "health_check_run",
      severity: alertsSent.length > 0 ? "warning" : "info",
      message: alertsSent.length > 0
        ? `Health check: ${alertsSent.length} alert(s) sent, ${alertsSkipped.length} suppressed (deduped)`
        : alertsSkipped.length > 0
          ? `Health check: ${alertsSkipped.length} condition(s) active but suppressed (deduped)`
          : "Health check: all clear",
      metadata: {
        alerts_sent: alertsSent,
        alerts_skipped: alertsSkipped,
        checked_at: now.toISOString(),
      },
    });

    return json({ ok: true, alerts_sent: alertsSent, alerts_skipped: alertsSkipped });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("health-check error:", msg);
    // The watchdog must never fail silently — if health-check crashes, all monitoring is blind.
    try {
      await sendTelegram(
        telegramToken!,
        telegramChatId!,
        `🚨 <b>[TradeAgent] Health-Check CRASHED</b>\nThe monitoring watchdog threw an unhandled error — all alerts are paused until this is resolved.\nError: ${msg.slice(0, 200)}`
      );
    } catch { /* if Telegram itself is down, at minimum the 500 response will surface in Supabase logs */ }
    return json({ error: msg }, 500);
  }
});
