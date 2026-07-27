import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { getKalshiCredentials, generateAuthHeaders, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import { countTradesInWindow } from "../_shared/limits.ts";

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
const LOW_BALANCE_FLOOR_USD = 15; // below this, a typical live basket leg can no longer clear collateral

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

// Atomically checks-and-claims a dedup slot via the same advisory-lock-guarded
// claim_health_check_alert() RPC that _shared/telegram.ts's alertOnce() uses.
// Health-check previously ran its own check-then-act isDuped() + separate insert
// here — the exact same race class alertOnce() was fixed for (concurrent callers
// can all pass a plain SELECT-then-INSERT before either commits) — except this
// path is only exercised by concurrent *invocations* of health-check itself
// (e.g. an overlapping manual + cron run), not concurrent basket legs. Returns
// true if this caller won the claim (dedup row already inserted by the RPC) and
// should send; false if an unexpired dedup row already exists.
async function claimAlert(
  supabase: any,
  alertType: string,
  fingerprint: string,
  cooldownHours: number
): Promise<boolean> {
  const { data: shouldSend, error } = await supabase.rpc("claim_health_check_alert", {
    p_alert_type: alertType,
    p_fingerprint: fingerprint,
    p_cooldown_hours: cooldownHours,
  });
  if (error) {
    // Fail open — a monitoring-path RPC hiccup should never silently swallow a real alert.
    console.error(`claim_health_check_alert failed for ${alertType}:`, error);
    return true;
  }
  return !!shouldSend;
}

// Undoes a successful claim after a failed Telegram delivery, so the next run's
// claimAlert() doesn't treat a never-delivered alert as already sent for the
// full cooldown window. Scoped to rows created at/after `claimedAfter` so it
// can't delete an older, already-delivered dedup row for the same fingerprint.
async function unclaimAlert(
  supabase: any,
  alertType: string,
  fingerprint: string,
  claimedAfter: string
) {
  await supabase
    .from("compliance_log")
    .delete()
    .eq("event_type", "health_check_alert")
    .eq("metadata->>alert_type", alertType)
    .eq("metadata->>fingerprint", fingerprint)
    .gte("created_at", claimedAfter);
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
  // Each entry: { type, fingerprint, cooldownHours, message, context? }
  const pendingAlerts: { type: string; fingerprint: string; cooldownHours: number; message: string; context?: Record<string, unknown> }[] = [];
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
          message: `⚠️ [TradeAgent] Silence ${hoursSinceLastTrade.toFixed(0)}h — last: ${sinceStr} — signals present, check errors`,
          context: {
            hours_silent: hoursSinceLastTrade,
            last_trade_at: lastTrade?.created_at ?? null,
            last_strategy_id: lastTrade?.strategy_id ?? null,
            active_strategy_count: (activeStrategies ?? []).filter(s => !s.suspended_until || new Date(s.suspended_until) < now).length,
            has_recent_signals: true,
          },
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
          message: `🔴 [TradeAgent] Win rate ${(winRate * 100).toFixed(0)}% (${wins}W/${losses}L of ${recentSettled.length}) — floor ${(WIN_RATE_FLOOR * 100).toFixed(0)}%`,
          context: {
            win_rate: winRate,
            wins,
            losses,
            sample_size: recentSettled.length,
            floor: WIN_RATE_FLOOR,
            strategy_breakdown: Object.entries(
              recentSettled.reduce((acc: Record<string, { w: number; l: number }>, t: any) => {
                const k = t.strategy_id ?? "unknown";
                if (!acc[k]) acc[k] = { w: 0, l: 0 };
                if (Number(t.pnl) > 0) acc[k].w++; else acc[k].l++;
                return acc;
              }, {})
            ),
          },
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
        message: `🚨 [TradeAgent] Volume spike: ${lastHourCount}/hr vs avg ${priorHourlyAvg.toFixed(1)} (${((lastHourCount ?? 0) / priorHourlyAvg).toFixed(1)}x) — check cron`,
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
        message: `🔄 [TradeAgent] Duplicate positions: ${tickerList.join(", ")} (${duplicateEntries.length} pairs >2 open rows)`,
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
        message: `🚫 [TradeAgent] Blocked series traded: ${sample} (${violations.length}x) — fix ALLOWED_PREFIXES`,
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
        message: `⏸️ [TradeAgent] Suspended: ${suspended.map((s: any) => `${s.name} until ${new Date(s.suspended_until).toISOString().slice(11, 16)}Z`).join(", ")}`,
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
        message: `🔴 [TradeAgent] ${recentErrors.length} error(s): ${recentErrors[0].event_type} — ${recentErrors[0].message.slice(0, 80)}`,
        context: {
          error_count: recentErrors.length,
          errors: recentErrors.slice(0, 5).map((e: any) => ({
            event_type: e.event_type,
            message: e.message,
            created_at: e.created_at,
          })),
        },
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
        message: `🔴 [TradeAgent] ${provider.toUpperCase()} ${isRateLimit ? "429" : status}: ${info.count}x in 2h — ${info.message.slice(0, 80)}`,
      });
    }

    // ── 8b. Internal live-mode rate limiting — invisible to the API_ERROR_TYPES sweep ──
    // execute-trade's own per-user rate limiter (checkRateLimit, 3/min live vs 15/min paper)
    // logs `rate_limit_exceeded` on every rejection, but that event_type isn't in
    // API_ERROR_TYPES above — it's an internal throttle, not an upstream provider error, so
    // it was never swept. Found 2026-07-26 20:05 UTC: 5 live rejections in ~1s with zero
    // Telegram signal, the same "looks fine, isn't" blind spot as the earlier trading_silence
    // and cron-registration gaps. Paper-mode hits are excluded (15/min is loose and expected
    // to trip during normal multi-leg baskets); only live matters — a real order didn't clear
    // because our own throttle blocked it, which is worth knowing even if by design.
    const { data: liveRateLimits } = await supabase
      .from("compliance_log")
      .select("id, created_at")
      .eq("event_type", "rate_limit_exceeded")
      .eq("metadata->>mode", "live")
      .gte("created_at", twoHoursAgo)
      .limit(50);

    if (liveRateLimits && liveRateLimits.length > 0) {
      // Fingerprint on the current 2h bucket start so a sustained throttle re-alerts
      // once per window instead of once per rejection.
      const fingerprint = `live_rate_limit_${twoHoursAgo.slice(0, 13)}`;
      pendingAlerts.push({
        type: "live_rate_limit_exceeded",
        fingerprint,
        cooldownHours: 2,
        message: `🟠 [TradeAgent] Live execute-trade rate-limited ${liveRateLimits.length}x in 2h (cap: 3/min) — real orders were throttled, check basket leg volume`,
      });
    }

    // ── 9. Cron health — stale (parked/dead) or failing jobs ─────────
    // Closes the silent-death blind spot: the other checks only see FAILED runs,
    // so a job parked to a never-date schedule (or otherwise stalled) fired zero
    // and read as healthy. cron_health() learns each job's real cadence from run
    // history and flags any active job overdue by >3x, plus any whose last run failed.
    const { data: cronRows, error: cronErr } = await supabase.rpc("cron_health");
    if (cronErr) {
      // Don't let a monitoring-surface failure pass silently — the watchdog itself must be loud.
      pendingAlerts.push({
        type: "cron_health_unavailable",
        fingerprint: `cron_health_err_${cronErr.message?.slice(0, 40) ?? "unknown"}`,
        cooldownHours: 6,
        message: `🟠 [TradeAgent] Cron monitor blind — cron_health() failed: ${(cronErr.message ?? String(cronErr)).slice(0, 100)}`,
      });
    }
    for (const c of cronRows ?? []) {
      if (c.last_status === "missing") {
        // In the manifest (expected_cron_jobs) but absent from cron.job entirely —
        // never scheduled, not just stalled. Re-alerts every 6h until registered.
        pendingAlerts.push({
          type: "cron_missing",
          fingerprint: `cron_missing_${c.jobname}`,
          cooldownHours: 6,
          message: `🚨 [TradeAgent] ${c.jobname} is not registered in cron.job — expected but never scheduled`,
        });
      } else if (c.is_stale) {
        const mins = Math.round((c.seconds_since_last_run ?? 0) / 60);
        const expMin = Math.round((c.expected_interval_s ?? 0) / 60);
        // Fingerprint on jobname → one alert per stalled job; re-alerts each 6h it stays stale.
        pendingAlerts.push({
          type: "cron_stale",
          fingerprint: `cron_stale_${c.jobname}`,
          cooldownHours: 6,
          message: `⏱️ [TradeAgent] ${c.jobname} stalled ${mins}m (expected ~${expMin}m) — last: ${c.last_started_at ? String(c.last_started_at).slice(0, 16) + "Z" : "never"}`,
        });
      }
      if (c.last_run_failed) {
        // Include the failed run's date → a NEW failure re-alerts; the same stuck one doesn't spam.
        pendingAlerts.push({
          type: "cron_failed",
          fingerprint: `cron_failed_${c.jobname}_${c.last_started_at ? String(c.last_started_at).slice(0, 10) : "na"}`,
          cooldownHours: 12,
          message: `❌ [TradeAgent] ${c.jobname} failed at ${c.last_started_at ? String(c.last_started_at).slice(0, 16) + "Z" : "?"} — check cron.job_run_details`,
        });
      }
    }

    // ── 10. Live account balance — early warning before orders start failing ──
    // 2026-07-25 incident: a live basket kept getting Kalshi's insufficient_balance
    // 400 for 3 legs / ~10min before anyone noticed — the only signal was noisy
    // per-order error rows, no proactive "you're low on funds" alert. This check
    // surfaces the real account balance directly so a shortfall is caught before
    // it silently blocks every live trade attempt.
    const { data: liveKeys } = await supabase
      .from("api_keys")
      .select("user_id")
      .eq("provider", "kalshi_live")
      .not("user_id", "is", null);

    for (const { user_id } of liveKeys ?? []) {
      try {
        const { keyId, privateKey } = await getKalshiCredentials(supabase, user_id);
        if (!keyId || !privateKey) continue;
        // Sign against the full path (Kalshi's HMAC scheme includes it), but fetch
        // against KALSHI_BASE_URL alone — it already ends in /trade-api/v2, so
        // appending the full path here doubled the segment (.../v2/trade-api/v2/...),
        // Kalshi 404'd every call, and the silent `if (!resp.ok) continue` below
        // swallowed it — this alert has never once fired, including today, with the
        // live account sitting at $1.66 (floor $15) for hours.
        const path = "/trade-api/v2/portfolio/balance";
        const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, Date.now());
        const resp = await fetch(`${KALSHI_BASE_URL}/portfolio/balance`, { headers });
        if (!resp.ok) continue; // don't let a transient Kalshi/auth hiccup page anyone
        const data = await resp.json();
        const balanceUsd = (data?.balance ?? 0) / 100;
        if (balanceUsd < LOW_BALANCE_FLOOR_USD) {
          pendingAlerts.push({
            type: "kalshi_low_balance",
            fingerprint: `low_balance_${user_id}`,
            cooldownHours: 12,
            message: `💸 [TradeAgent] Live Kalshi balance low: $${balanceUsd.toFixed(2)} — live trades will start failing insufficient_balance. Deposit funds.`,
          });
        }
      } catch {
        // Monitoring-path failure only — never let this block the rest of the sweep.
      }
    }

    // ── 11. Live trading blocked by daily cap — invisible to the silence check ──
    // trading_silence (#1) only fires when the whole trades table goes quiet, but
    // paper-mode strategies keep inserting rows every cycle even when a user's live
    // trading is fully capped — so a live account can sit `risk_blocked` for hours
    // with zero signal (found 2026-07-26: 52/50 live trades in the trailing 24h,
    // blocked since ~19:10 UTC the prior day, no alert). Recomputes the exact same
    // gate auto-trade enforces (risk_settings.max_daily_trades, countTradesInWindow
    // over 24h) instead of re-deriving it, so this can't drift from the real block.
    for (const { user_id } of liveKeys ?? []) {
      try {
        const { data: riskRow } = await supabase
          .from("risk_settings")
          .select("max_daily_trades")
          .eq("user_id", user_id)
          .eq("mode", "live")
          .maybeSingle();
        const maxDailyTrades = riskRow?.max_daily_trades ?? 30;
        const liveTradeCount = await countTradesInWindow(supabase, user_id, "live");
        if (liveTradeCount >= maxDailyTrades) {
          pendingAlerts.push({
            type: "live_trading_cap_blocked",
            fingerprint: `cap_blocked_${user_id}_${now.toISOString().slice(0, 10)}`,
            cooldownHours: 6,
            message: `⏸️ [TradeAgent] Live trading paused: daily cap ${liveTradeCount}/${maxDailyTrades} reached (trailing 24h) — no live orders until the window rolls off`,
          });
        }
      } catch {
        // Monitoring-path failure only — never let this block the rest of the sweep.
      }
    }

    // ── Deduplicate and send ──────────────────────────────────────────
    // For each pending alert, check compliance_log to see if the same fingerprint
    // was already sent within the cooldown window. Only send new or escalating alerts.
    const alertsSent: string[] = [];
    const alertsSkipped: string[] = [];

    for (const alert of pendingAlerts) {
      const claimedAt = new Date().toISOString();
      const shouldSend = await claimAlert(supabase, alert.type, alert.fingerprint, alert.cooldownHours);
      if (!shouldSend) {
        alertsSkipped.push(alert.type);
        continue;
      }

      const delivered = await sendTelegram(telegramToken, telegramChatId, alert.message);

      if (!delivered) {
        // Delivery failed — the RPC already claimed the dedup slot (that's the
        // atomicity fix), so undo it here rather than leaving a never-delivered
        // alert marked as sent for the full cooldown window. Log the failure
        // itself (undeduped, always visible) so it surfaces via the
        // system_errors sweep on the next run.
        await unclaimAlert(supabase, alert.type, alert.fingerprint, claimedAt);
        await supabase.from("compliance_log").insert({
          event_type: "telegram_delivery_failed",
          severity: "critical",
          message: `Telegram send failed for alert "${alert.type}" — will retry next run`,
          metadata: { alert_type: alert.type, fingerprint: alert.fingerprint },
        });
        alertsSkipped.push(`${alert.type}(delivery_failed)`);
        continue;
      }

      // claim_health_check_alert() already wrote the health_check_alert dedup row
      // (event_type/severity/message/alert_type/fingerprint). Diagnostic context (if
      // any) is folded into that same row via an update rather than a separate
      // "diagnostic_needed" event — no consumer for that event type has ever existed
      // (verified: zero call sites read it, every row written since 07-21 sat with
      // resolved:false indefinitely), so it was an unbounded, never-drained queue.
      // The context is still fully visible on this row for whoever investigates.
      if (alert.context) {
        await supabase
          .from("compliance_log")
          .update({ metadata: { alert_type: alert.type, fingerprint: alert.fingerprint, diagnostic_context: alert.context } })
          .eq("event_type", "health_check_alert")
          .eq("metadata->>alert_type", alert.type)
          .eq("metadata->>fingerprint", alert.fingerprint)
          .gte("created_at", claimedAt);
      }

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
        `🚨 [TradeAgent] Health-check crashed — all monitoring paused: ${msg.slice(0, 150)}`
      );
    } catch { /* if Telegram itself is down, at minimum the 500 response will surface in Supabase logs */ }
    return json({ error: msg }, 500);
  }
});
