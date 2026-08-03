/**
 * sendUserNotification — fire-and-forget user notification dispatcher.
 *
 * Respects per-user notification_prefs stored in profiles.notification_prefs (JSONB).
 * Routes to SendGrid (email) and/or Twilio (SMS) based on channel preference.
 * Never throws — all errors are swallowed and logged. Callers use .catch(() => {}).
 *
 * Usage:
 *   sendUserNotification(supabase, { userId, eventType, subject, htmlBody, smsBody })
 *     .catch(() => {}); // always fire-and-forget
 */

const SENDER_EMAIL = "tradeagentcomm@yahoo.com";
const SENDER_NAME  = "TradeAgent";
const DASHBOARD_URL = "https://kalshitradeagent.com";
const NOTIFICATION_FETCH_TIMEOUT_MS = 8_000;

export type NotifEventType =
  | "trade_executed"
  | "position_closed"
  | "stop_loss_hit"
  | "agent_alerts";

export interface NotifOpts {
  userId: string;
  eventType: NotifEventType;
  subject: string;
  htmlBody: string;
  smsBody: string;        // ≤160 chars for single-part SMS
  forceChannel?: "both";  // override for critical alerts — always email + SMS
}

export async function sendUserNotification(
  supabase: ReturnType<typeof import("npm:@supabase/supabase-js@2").createClient>,
  opts: NotifOpts,
): Promise<void> {
  try {
    // 1. Fetch profile prefs + phone
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone, notification_prefs")
      .eq("id", opts.userId)
      .maybeSingle();

    const prefs = (profile?.notification_prefs ?? {}) as Record<string, unknown>;

    // 2. Check if this event type is enabled — default true for critical alerts
    const prefKey = opts.eventType; // keys match: "trade_executed", "position_closed", etc.
    const enabled = opts.forceChannel === "both" ? true : prefs[prefKey] !== false && prefs[prefKey] !== undefined ? !!prefs[prefKey] : false;
    if (!enabled) {
      console.debug(`notifications: ${opts.eventType} disabled for user ${opts.userId}`);
      return;
    }

    // 3. Determine channel
    const rawChannel = opts.forceChannel ?? ((prefs.channel as string) || "email");
    const doEmail = rawChannel === "email" || rawChannel === "both";
    const doSms   = rawChannel === "sms"   || rawChannel === "both";

    // 4. Get email address from auth admin
    let email: string | null = null;
    if (doEmail) {
      try {
        const { data: authData } = await supabase.auth.admin.getUserById(opts.userId);
        email = authData?.user?.email ?? null;
      } catch {
        console.warn(`notifications: could not fetch email for user ${opts.userId}`);
      }
    }

    // 5. Send email via SendGrid
    if (doEmail && email) {
      const sendgridKey = Deno.env.get("SENDGRID_API_KEY");
      if (sendgridKey) {
        sendEmail(sendgridKey, email, opts.subject, wrapHtml(opts.htmlBody))
          .catch((e: Error) => console.warn("notifications: email send failed:", e.message));
      } else {
        console.warn("notifications: SENDGRID_API_KEY not set — skipping email");
      }
    }

    // 6. Send SMS via Twilio
    if (doSms && profile?.phone) {
      const sid    = Deno.env.get("TWILIO_ACCOUNT_SID");
      const auth   = Deno.env.get("TWILIO_AUTH_TOKEN");
      const from   = Deno.env.get("TWILIO_FROM_NUMBER");
      if (sid && auth && from) {
        sendSms(sid, auth, from, profile.phone as string, opts.smsBody)
          .catch((e: Error) => console.warn("notifications: SMS send failed:", e.message));
      } else {
        console.warn("notifications: Twilio credentials not configured — skipping SMS");
      }
    }

  } catch (e) {
    // Never crash the caller
    console.error("notifications: unexpected error:", e instanceof Error ? e.message : e);
  }
}

// ── Wraps an HTML snippet in a dark-theme email shell ────────────────────────

function wrapHtml(body: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;margin:0;padding:40px 20px;">
<div style="max-width:520px;margin:0 auto;background:#1a1a1a;border-radius:16px;padding:40px;border:1px solid rgba(255,255,255,0.06);">
  <p style="color:#22c55e;font-size:13px;font-weight:600;letter-spacing:0.05em;margin:0 0 24px;text-transform:uppercase;">TradeAgent</p>
  ${body}
  <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <a href="${DASHBOARD_URL}" style="color:#22c55e;font-size:12px;text-decoration:none;">View dashboard →</a>
    &nbsp;&nbsp;
    <a href="${DASHBOARD_URL}/settings" style="color:rgba(255,255,255,0.3);font-size:12px;text-decoration:none;">Notification settings</a>
  </div>
</div>
</body>
</html>`;
}

// ── SendGrid ─────────────────────────────────────────────────────────────────

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFICATION_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: SENDER_EMAIL, name: SENDER_NAME },
        reply_to: { email: SENDER_EMAIL },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SendGrid ${resp.status}: ${body.slice(0, 200)}`);
  }
}

// ── Twilio ───────────────────────────────────────────────────────────────────

async function sendSms(
  sid: string,
  auth: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFICATION_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${auth}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Twilio ${resp.status}: ${text.slice(0, 200)}`);
  }
}
