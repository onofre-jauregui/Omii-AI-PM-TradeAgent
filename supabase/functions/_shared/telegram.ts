/**
 * Shared Telegram alert helper.
 * Fire-and-forget — never throws, never blocks the critical path.
 * Used by any edge function that needs to alert on critical events immediately
 * rather than waiting for the hourly health-check poll.
 */

export async function sendTelegramAlert(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
  }).catch(() => {});
}
