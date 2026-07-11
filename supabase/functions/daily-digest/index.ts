import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SENDER_EMAIL = "tradeagentcomm@yahoo.com";
const SENDER_NAME  = "TradeAgent";
const DASHBOARD_URL = "https://kalshitradeagent.com";

serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const sendgridKey = Deno.env.get("SENDGRID_API_KEY");
  const twilioSid   = Deno.env.get("TWILIO_ACCOUNT_SID");
  const twilioAuth  = Deno.env.get("TWILIO_AUTH_TOKEN");
  const twilioFrom  = Deno.env.get("TWILIO_FROM_NUMBER");

  // 1. Fetch all users opted in to daily_summary
  const { data: users, error: usersErr } = await supabase.rpc("exec_sql", {
    query: `
      SELECT p.id, p.phone, p.notification_prefs, u.email
      FROM public.profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE (p.notification_prefs->>'daily_summary')::boolean = true
    `,
  }).catch(() => ({ data: null, error: "rpc_unavailable" }));

  // Fall back to direct table query if exec_sql isn't available
  const userRows: Array<{ id: string; phone: string | null; notification_prefs: Record<string, unknown>; email: string }> =
    (usersErr || !users)
      ? await fetchUsersDirectly(supabase)
      : users;

  if (!userRows.length) {
    console.log("daily-digest: no opted-in users, nothing to send");
    return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });
  }

  let sent = 0;
  const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayStartET = new Date(nyNow);
  todayStartET.setHours(0, 0, 0, 0);

  for (const user of userRows) {
    try {
      const stats = await getDayStats(supabase, user.id, todayStartET);

      // Skip if no live trades settled today — no activity = no send
      if (stats.totalTrades === 0) continue;

      const prefs = user.notification_prefs ?? {};
      const channel = (prefs.channel as string) ?? "email";

      if ((channel === "email" || channel === "both") && sendgridKey && user.email) {
        await sendEmail(sendgridKey, user.email, stats);
      }

      if ((channel === "sms" || channel === "both") && twilioSid && twilioAuth && twilioFrom && user.phone) {
        await sendSms(twilioSid, twilioAuth, twilioFrom, user.phone, stats);
      }

      // Log compliance record
      await supabase.from("compliance_log").insert({
        user_id: user.id,
        event_type: "daily_digest",
        channel,
        payload: stats,
        created_at: new Date().toISOString(),
      }).then(undefined, (e: unknown) => console.warn("compliance_log insert failed:", e));

      sent++;
    } catch (err) {
      console.error(`daily-digest: failed for user ${user.id}:`, err);
    }
  }

  console.log(`daily-digest: sent ${sent}/${userRows.length}`);
  return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
});

async function fetchUsersDirectly(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, phone, notification_prefs")
    .filter("notification_prefs->>daily_summary", "eq", "true");

  if (error || !data) return [];

  const ids = data.map((r: { id: string }) => r.id);
  if (!ids.length) return [];

  // Fetch emails from auth.users via the admin API
  const users = [];
  for (const row of data as Array<{ id: string; phone: string | null; notification_prefs: Record<string, unknown> }>) {
    const { data: authUser } = await supabase.auth.admin.getUserById(row.id);
    if (authUser?.user?.email) {
      users.push({ ...row, email: authUser.user.email });
    }
  }
  return users;
}

interface DayStats {
  totalTrades: number;
  wins: number;
  losses: number;
  netPnl: number;
  openPositions: number;
  winRate: number;
}

async function getDayStats(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  todayStartET: Date,
): Promise<DayStats> {
  const { data, error } = await supabase
    .from("trades")
    .select("pnl, settled_at, status")
    .eq("user_id", userId)
    .eq("mode", "live")
    .gte("settled_at", todayStartET.toISOString());

  if (error || !data) return { totalTrades: 0, wins: 0, losses: 0, netPnl: 0, openPositions: 0, winRate: 0 };

  const settled = data.filter((t: { settled_at: string | null }) => t.settled_at);
  const wins    = settled.filter((t: { pnl: number }) => t.pnl > 0).length;
  const losses  = settled.filter((t: { pnl: number }) => t.pnl <= 0).length;
  const netPnl  = settled.reduce((sum: number, t: { pnl: number }) => sum + (t.pnl ?? 0), 0);

  const { count: openPositions } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("mode", "live")
    .is("settled_at", null)
    .not("status", "in", '("failed","cancelled")');

  return {
    totalTrades: settled.length,
    wins,
    losses,
    netPnl,
    openPositions: openPositions ?? 0,
    winRate: settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0,
  };
}

async function sendEmail(apiKey: string, email: string, stats: DayStats): Promise<void> {
  const sign    = stats.netPnl >= 0 ? "+" : "-";
  const pnlAbs  = Math.abs(stats.netPnl).toFixed(2);
  const subject = `Daily summary — ${sign}$${pnlAbs} today`;
  const pnlColor = stats.netPnl >= 0 ? "#22c55e" : "#ef4444";

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;margin:0;padding:40px 20px;">
<div style="max-width:520px;margin:0 auto;background:#1a1a1a;border-radius:16px;padding:40px;border:1px solid rgba(255,255,255,0.06);">
  <p style="color:#22c55e;font-size:13px;font-weight:600;letter-spacing:0.05em;margin:0 0 24px;text-transform:uppercase;">TradeAgent</p>
  <h1 style="color:#fff;font-size:32px;font-weight:700;margin:0 0 4px;color:${pnlColor};">${sign}$${pnlAbs}</h1>
  <p style="color:rgba(255,255,255,0.5);font-size:14px;margin:0 0 32px;">Net P&L today (live trading)</p>

  <div style="display:flex;gap:16px;margin-bottom:32px;">
    <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:12px;padding:16px;text-align:center;">
      <p style="color:#22c55e;font-size:22px;font-weight:700;margin:0;">${stats.wins}</p>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;margin:4px 0 0;">Wins</p>
    </div>
    <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:12px;padding:16px;text-align:center;">
      <p style="color:#ef4444;font-size:22px;font-weight:700;margin:0;">${stats.losses}</p>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;margin:4px 0 0;">Losses</p>
    </div>
    <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:12px;padding:16px;text-align:center;">
      <p style="color:#fff;font-size:22px;font-weight:700;margin:0;">${stats.winRate}%</p>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;margin:4px 0 0;">Win Rate</p>
    </div>
  </div>

  ${stats.openPositions > 0 ? `
  <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0 0 24px;">
    ${stats.openPositions} position${stats.openPositions > 1 ? "s" : ""} still open — settling overnight.
  </p>` : ""}

  <a href="${DASHBOARD_URL}" style="display:inline-block;background:#22c55e;color:#000;font-size:14px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:100px;margin-bottom:32px;">View dashboard →</a>

  <p style="color:rgba(255,255,255,0.2);font-size:11px;margin:0;line-height:1.6;">
    You're receiving this daily summary because notifications are enabled in your TradeAgent account.<br>
    <a href="${DASHBOARD_URL}/settings" style="color:rgba(255,255,255,0.3);">Unsubscribe or change preferences</a>
  </p>
</div>
</body>
</html>`;

  const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: SENDER_EMAIL, name: SENDER_NAME },
      reply_to: { email: SENDER_EMAIL },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SendGrid ${resp.status}: ${body.slice(0, 200)}`);
  }
}

async function sendSms(
  sid: string, auth: string, from: string, to: string, stats: DayStats,
): Promise<void> {
  const sign = stats.netPnl >= 0 ? "+" : "-";
  const pnlAbs = Math.abs(stats.netPnl).toFixed(2);
  const body = `TradeAgent: ${sign}$${pnlAbs} today (${stats.wins}W/${stats.losses}L${stats.openPositions > 0 ? `, ${stats.openPositions} open` : ""}). ${DASHBOARD_URL}`;

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${auth}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Twilio ${resp.status}: ${text.slice(0, 200)}`);
  }
}
