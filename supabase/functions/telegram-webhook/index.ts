import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * telegram-webhook: Receives Telegram bot messages and dispatches commands.
 *
 * Supported commands:
 *   /status   — last 10 compliance_log events + open positions + last trade time
 *   /health   — invoke health-check and return alert list
 *   /429      — last 10 Kalshi 429 events from compliance_log
 *   /run mdf  — invoke market-data-fetcher and return result
 *   /run trade — invoke auto-trade and return summary
 *   /help     — list commands
 *
 * Security: Telegram sends a secret token in the URL query string.
 * We reject any request where it doesn't match TELEGRAM_WEBHOOK_SECRET.
 *
 * Registered via:
 *   POST https://api.telegram.org/bot<TOKEN>/setWebhook
 *   { url: "https://<project>.supabase.co/functions/v1/telegram-webhook?secret=<SECRET>" }
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

async function reply(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

async function invokeFunction(name: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  return res.json().catch(() => ({ error: "non-JSON response" }));
}

serve(async (req) => {
  // Validate webhook secret
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Handle HITL approval callbacks (inline keyboard button presses)
  const callbackQuery = body?.callback_query;
  if (callbackQuery) {
    const callbackData: string = callbackQuery.data || "";
    const callbackChatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id || "");

    // Security: only process callbacks from our configured chat
    if (callbackChatId !== CHAT_ID) {
      return new Response("OK", { status: 200 });
    }

    const hitlApproveMatch = callbackData.match(/^hitl_(approve|reject)_([0-9a-f-]+)$/);
    if (hitlApproveMatch) {
      const decision = hitlApproveMatch[1]; // "approve" or "reject"
      const approvalId = hitlApproveMatch[2];

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      // Fetch stored payload before updating status — needed for execution
      const { data: approvalRecord } = await supabase.from("hitl_approvals")
        .select("trade_payload, user_id, trace_id, status")
        .eq("id", approvalId)
        .single();

      // Guard: only act if still pending (prevents double-tap and stale callbacks)
      if (!approvalRecord || approvalRecord.status !== "pending") {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQuery.id,
            text: `Already ${approvalRecord?.status ?? "processed"} — no action taken`,
            show_alert: true,
          }),
        }).catch(() => {});
        return new Response("OK", { status: 200 });
      }

      // Mark the decision
      await supabase.from("hitl_approvals")
        .update({
          status: decision === "approve" ? "approved" : "rejected",
          decided_at: new Date().toISOString(),
          decision_note: `${decision}d via Telegram by operator`,
        })
        .eq("id", approvalId)
        .eq("status", "pending");

      // Answer callback immediately — dismiss Telegram's spinner
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQuery.id,
          text: decision === "approve" ? "✅ Executing trade now…" : "❌ Trade rejected",
          show_alert: false,
        }),
      }).catch(() => {});

      let resultLine = decision === "approve" ? "✅ APPROVED — executing…" : "❌ REJECTED";

      // On approval: call execute-trade with the stored payload + pre-auth ID
      if (decision === "approve" && approvalRecord.trade_payload) {
        const executePayload = {
          ...approvalRecord.trade_payload,
          hitlApprovalId: approvalId, // Phase 2 bypass token
        };
        try {
          const execResp = await fetch(`${SUPABASE_URL}/functions/v1/execute-trade`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SUPABASE_KEY}`,
              apikey: SUPABASE_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(executePayload),
          });
          const execResult = await execResp.json().catch(() => ({})) as Record<string, unknown>;
          if (execResult.success) {
            const tradeId = (execResult.trade as Record<string, unknown>)?.id;
            resultLine = `✅ APPROVED — trade executed${tradeId ? ` (${String(tradeId).slice(0, 8)})` : ""}`;
          } else {
            const errMsg = String(execResult.error || "unknown error").slice(0, 100);
            resultLine = `✅ APPROVED but execution failed: ${errMsg}`;
          }
        } catch (execErr) {
          const msg = execErr instanceof Error ? execErr.message : String(execErr);
          resultLine = `✅ APPROVED but execution threw: ${msg.slice(0, 100)}`;
        }
      }

      // Edit the original Telegram message to show the final outcome
      if (callbackQuery.message?.message_id) {
        const timestamp = new Date().toISOString().slice(11, 19);
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            message_id: callbackQuery.message.message_id,
            text: callbackQuery.message.text + `\n\n${resultLine} at ${timestamp} UTC`,
            parse_mode: "HTML",
          }),
        }).catch(() => {});
      }
    }

    return new Response("OK", { status: 200 });
  }

  const message = body?.message;
  if (!message?.text) return new Response("OK", { status: 200 });

  // Only respond to the configured chat
  if (String(message.chat?.id) !== CHAT_ID) {
    return new Response("OK", { status: 200 });
  }

  const text: string = message.text.trim().toLowerCase();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = new Date();

  try {
    // /help
    if (text === "/help" || text === "/start") {
      await reply(
        `<b>KalshiTradeAgent Commands</b>\n\n` +
        `/status — system snapshot (errors, positions, last trade)\n` +
        `/health — run health checks now\n` +
        `/429 — last Kalshi rate limit events\n` +
        `/run mdf — refresh market data (market-data-fetcher)\n` +
        `/run trade — trigger auto-trade cycle\n` +
        `/help — this message`
      );

    // /status
    } else if (text === "/status") {
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

      const [{ data: recentEvents }, { data: lastTrade }, { count: openCount }] = await Promise.all([
        supabase.from("compliance_log")
          .select("event_type, severity, message, created_at")
          .gte("created_at", twoHoursAgo)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase.from("trades")
          .select("created_at, ticker, strategy")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from("trades")
          .select("id", { count: "exact", head: true })
          .is("settled_at", null)
          .eq("status", "filled"),
      ]);

      const lastTradeStr = lastTrade
        ? `${lastTrade.ticker} (${lastTrade.strategy}) — ${new Date(lastTrade.created_at).toISOString().slice(0, 16)} UTC`
        : "none";

      const eventLines = (recentEvents || [])
        .map((e: any) => {
          const icon = e.severity === "error" || e.severity === "critical" ? "🔴" :
                       e.severity === "warning" ? "⚠️" : "✅";
          return `${icon} ${e.event_type}: ${e.message.slice(0, 70)}`;
        })
        .join("\n");

      await reply(
        `<b>TradeAgent Status</b>\n\n` +
        `Open positions: ${openCount ?? 0}\n` +
        `Last trade: ${lastTradeStr}\n\n` +
        `<b>Recent events (2h):</b>\n${eventLines || "none"}`
      );

    // /429
    } else if (text === "/429") {
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
      const { data: events } = await supabase
        .from("compliance_log")
        .select("message, created_at")
        .ilike("message", "%429%")
        .gte("created_at", sixHoursAgo)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!events || events.length === 0) {
        await reply("✅ No Kalshi 429 errors in the last 6 hours.");
      } else {
        const lines = events
          .map((e: any) => `• ${new Date(e.created_at).toISOString().slice(11, 16)} UTC — ${e.message.slice(0, 80)}`)
          .join("\n");
        await reply(`<b>Kalshi 429s (last 6h) — ${events.length} events</b>\n\n${lines}`);
      }

    // /health
    } else if (text === "/health") {
      await reply("⏳ Running health check...");
      const result = await invokeFunction("health-check");
      if (result.error) {
        await reply(`🔴 health-check failed: ${result.error}`);
      } else if (result.alerts_sent === 0) {
        await reply("✅ Health check: all clear — no alerts.");
      } else {
        await reply(`⚠️ Health check complete: ${result.alerts_sent} alert(s) sent above.`);
      }

    // /run mdf
    } else if (text === "/run mdf" || text === "/run market-data") {
      await reply("⏳ Refreshing market data...");
      const result = await invokeFunction("market-data-fetcher");
      if (result.error) {
        await reply(`🔴 market-data-fetcher failed: ${result.error}`);
      } else {
        const failed = result.series_failed?.length ?? 0;
        const ok = result.series_fetched ?? 0;
        const markets = result.total_markets_cached ?? 0;
        const icon = failed > 0 ? "⚠️" : "✅";
        await reply(
          `${icon} Market data refresh complete\n` +
          `${ok}/${ok + failed} series OK — ${markets} markets cached` +
          (failed > 0 ? `\nFailed: ${result.series_failed.join(", ")}` : "")
        );
      }

    // /run trade
    } else if (text === "/run trade" || text === "/run auto-trade") {
      await reply("⏳ Triggering auto-trade cycle (may take up to 30s)...");
      const result = await invokeFunction("auto-trade");
      if (result.error) {
        await reply(`🔴 auto-trade failed: ${result.error}`);
      } else {
        await reply(
          `✅ Auto-trade complete\n` +
          `Strategies run: ${result.strategies_run ?? "?"}\n` +
          `Trades placed: ${result.trades_placed ?? 0}\n` +
          `Errors: ${result.errors ?? 0}`
        );
      }

    } else {
      await reply(`Unknown command. Send /help to see available commands.`);
    }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await reply(`🔴 Internal error: ${msg}`);
  }

  return new Response("OK", { status: 200 });
});
