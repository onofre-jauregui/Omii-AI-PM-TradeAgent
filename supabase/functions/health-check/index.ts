import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

/**
 * health-check: Monitors the trading agent and alerts via Telegram when:
 *   1. No trades placed in SILENCE_HOURS (default 4h) while strategies are active
 *   2. Win rate collapses (last 20 settled trades < 70%)
 *   3. A strategy has been auto-suspended
 *
 * Triggered by pg_cron every hour. Also callable manually for diagnostics.
 */

const SILENCE_HOURS = 4;
const WIN_RATE_FLOOR = 0.70;
const WIN_RATE_SAMPLE = 20;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID");

  if (!supabaseUrl || !supabaseKey) return json({ error: "Missing Supabase credentials" }, 500);
  if (!telegramToken || !telegramChatId) return json({ error: "Missing Telegram credentials" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey);
  const alerts: string[] = [];
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
        const sinceStr = lastTradeTime
          ? `${hoursSinceLastTrade.toFixed(1)}h ago (${lastTradeTime.toISOString().slice(0, 16)} UTC)`
          : "never";
        alerts.push(
          `⚠️ <b>[TradeAgent] Trading Silence</b>\n` +
          `No trades placed in ${hoursSinceLastTrade.toFixed(1)}h.\n` +
          `Last trade: ${sinceStr}\n` +
          `Strategies active: ${(activeStrategies || []).map((s) => s.name).join(", ")}\n` +
          `Signals present: yes — check compliance_log for errors.`
        );
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
      const wins = recentSettled.filter((t) => Number(t.pnl) > 0).length;
      const winRate = wins / recentSettled.length;
      if (winRate < WIN_RATE_FLOOR) {
        alerts.push(
          `🔴 <b>[TradeAgent] Win Rate Collapse</b>\n` +
          `Last ${recentSettled.length} settled trades: ${wins}W/${recentSettled.length - wins}L (${(winRate * 100).toFixed(1)}% — floor is ${(WIN_RATE_FLOOR * 100).toFixed(0)}%)\n` +
          `Review recent signals and strategy filters.`
        );
      }
    }

    // ── 3. Suspended strategy check ───────────────────────────────────
    const suspended = (activeStrategies || []).filter(
      (s) => s.suspended_until && new Date(s.suspended_until) > now
    );
    if (suspended.length > 0) {
      alerts.push(
        `⏸️ <b>[TradeAgent] Strategy Suspended</b>\n` +
        suspended.map((s) =>
          `${s.name}: suspended until ${new Date(s.suspended_until).toISOString().slice(0, 16)} UTC`
        ).join("\n")
      );
    }

    // ── Send alerts ──────────────────────────────────────────────────
    for (const alert of alerts) {
      await sendTelegram(telegramToken, telegramChatId, alert);
    }

    // Log to compliance_log
    await supabase.from("compliance_log").insert({
      event_type: "health_check_run",
      severity: alerts.length > 0 ? "warning" : "info",
      message: alerts.length > 0
        ? `Health check: ${alerts.length} alert(s) sent to Telegram`
        : "Health check: all clear",
      metadata: { alerts_sent: alerts.length, checked_at: now.toISOString() },
    });

    return json({ ok: true, alerts_sent: alerts.length, alerts });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("health-check error:", msg);
    return json({ error: msg }, 500);
  }
});
