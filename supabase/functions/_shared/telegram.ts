/**
 * Shared Telegram alert helpers.
 *
 * sendTelegramAlert — fire-and-forget, never throws, never blocks.
 *
 * alertOnce — deduplicating alert. Sends Telegram only if the same
 * alert_type + fingerprint has NOT been sent within the cooldown window.
 * Uses compliance_log as the state store (no extra tables).
 *
 * Both functions use the same compliance_log event_type ("health_check_alert")
 * so the hourly health-check sweep never double-sends an alert that an edge
 * function already fired directly.
 */

// The doc comment above promises "never blocks," but the bare `await fetch()`
// this wrapped had no timeout — a stalled Telegram API call blocked every one
// of this helper's 12 callers (including health-check itself) for as long as
// the platform's own execution timeout allowed. Same failure shape closed
// across kalshi-ping/create-checkout/manage-billing/etc; this one actually
// breaks the contract this file's own docstring claims to guarantee.
const TELEGRAM_FETCH_TIMEOUT_MS = 8_000;

export async function sendTelegramAlert(message: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
      signal: controller.signal,
    }).catch(() => {});
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * alertOnce — sends a Telegram alert only if the same condition hasn't been
 * reported within the cooldown window.
 *
 * @param supabase   Supabase client (service role)
 * @param alertType  Stable string identifying the alert category (e.g. "lesson_write_error")
 * @param fingerprint  Captures the specific condition (e.g. trade ID, error message slice)
 * @param cooldownHours  How long before the same fingerprint can alert again
 * @param message    HTML-formatted Telegram message
 * @returns true if the alert was sent, false if it was suppressed (deduped)
 */
export async function alertOnce(
  supabase: any,
  alertType: string,
  fingerprint: string,
  cooldownHours: number,
  message: string,
): Promise<boolean> {
  try {
    // Atomic claim (see 20260726_alert_dedup_race.sql) — a Postgres advisory
    // lock serializes concurrent callers for the same alert_type+fingerprint
    // so only one of them claims the send. The old select-then-insert here
    // was check-then-act: concurrent callers (e.g. basket legs) could all
    // pass the SELECT before any INSERT committed, sending the same alert
    // multiple times.
    const { data: claimed, error } = await supabase.rpc("claim_health_check_alert", {
      p_alert_type: alertType,
      p_fingerprint: fingerprint,
      p_cooldown_hours: cooldownHours,
    });

    if (error) throw error;
    if (!claimed) return false; // already sent within cooldown, or lost the race

    await sendTelegramAlert(message);
    return true;
  } catch {
    // alertOnce must never crash the caller — fall through to raw send.
    await sendTelegramAlert(message).catch(() => {});
    return true;
  }
}
