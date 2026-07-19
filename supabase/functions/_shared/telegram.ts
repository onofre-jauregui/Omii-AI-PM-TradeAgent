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
    const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from("compliance_log")
      .select("id")
      .eq("event_type", "health_check_alert")
      .eq("metadata->>alert_type", alertType)
      .eq("metadata->>fingerprint", fingerprint)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();

    if (existing) return false; // already sent within cooldown

    await sendTelegramAlert(message);

    // Record so health-check sweep and future calls can deduplicate.
    await supabase.from("compliance_log").insert({
      event_type: "health_check_alert",
      severity: "warning",
      message: `Alert sent: ${alertType}`,
      metadata: { alert_type: alertType, fingerprint },
    }).then(undefined, () => {}); // don't let the record insert block the alert path

    return true;
  } catch {
    // alertOnce must never crash the caller — fall through to raw send.
    await sendTelegramAlert(message).catch(() => {});
    return true;
  }
}
