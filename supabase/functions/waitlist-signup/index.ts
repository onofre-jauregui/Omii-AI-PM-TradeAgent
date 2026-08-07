import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { makeCorsHeaders, preflight } from "../_shared/cors.ts";

// The SendGrid call below had no timeout and is awaited before the signup response
// returns — a stalled SendGrid request hung the user-facing waitlist form itself, up to
// the platform's own execution timeout, despite the comment above the call site claiming
// this path is "non-blocking." Same bound as the rest of the timeout-guard campaign.
const FETCH_TIMEOUT_MS = 8_000;

serve(async (req) => {
  // Pass the request so the allow-list reflects THIS caller's origin. Calling
  // preflight()/corsHeaders with no request pins Access-Control-Allow-Origin to
  // the first entry in the list (kalshitradeagent.com), so every other allowed
  // origin — staging, the vercel.app previews, localhost — is refused by the
  // browser. That is why the waitlist form could never be exercised anywhere
  // except production, which is precisely how a 100%-failing form went
  // unnoticed for eleven weeks.
  const cors = makeCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return preflight(req);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sendgridKey = Deno.env.get("SENDGRID_API_KEY");

  const { email, plan_interest } = await req.json().catch(() => ({}));
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return json({ ok: false, error: "Valid email required" }, 400, cors);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Insert — UNIQUE constraint on email means duplicate signups silently succeed
  const { error: insertErr } = await supabase
    .from("waitlist")
    .insert({
      email: email.trim().toLowerCase(),
      plan_interest: plan_interest ?? null,
    });

  if (insertErr && !insertErr.message.includes("duplicate")) {
    console.error("waitlist-signup insert error:", insertErr);
    return json({ ok: false, error: "Could not save. Please try again." }, 500, cors);
  }

  // Send confirmation email via SendGrid (non-blocking — don't fail signup if email fails)
  if (sendgridKey) {
    await sendConfirmation(sendgridKey, email.trim()).catch((e) =>
      console.error("waitlist-signup: confirmation email failed:", e.message)
    );
  } else {
    console.warn(
      "waitlist-signup: SENDGRID_API_KEY not set — skipping confirmation email",
    );
  }

  return json({ ok: true }, 200, cors);
});

async function sendConfirmation(apiKey: string, to: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: "tradeagentcomm@yahoo.com", name: "TradeAgent" },
        reply_to: { email: "tradeagentcomm@yahoo.com" },
        subject: "You're on the TradeAgent waitlist",
        content: [
          {
            type: "text/html",
            value: `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;margin:0;padding:40px 20px;">
<div style="max-width:520px;margin:0 auto;background:#1a1a1a;border-radius:16px;padding:40px;border:1px solid rgba(255,255,255,0.06);">
  <p style="color:#22c55e;font-size:13px;font-weight:600;letter-spacing:0.05em;margin:0 0 24px;text-transform:uppercase;">TradeAgent</p>
  <h1 style="color:#fff;font-size:28px;font-weight:700;margin:0 0 16px;line-height:1.2;">You're on the list.</h1>
  <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.6;margin:0 0 24px;">
    We're validating paper trading performance before opening live trading. When a spot opens, you'll get first access.
  </p>
  <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.6;margin:0 0 32px;">
    In the meantime, paper trading is <strong style="color:#fff;">free and available now</strong>. The agent runs on real market prices — no real money required.
  </p>
  <a href="https://omii-trade-agent.vercel.app/signup" style="display:inline-block;background:#22c55e;color:#000;font-size:14px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:100px;">Start paper trading →</a>
  <p style="color:rgba(255,255,255,0.3);font-size:12px;margin:32px 0 0;">
    You're receiving this because you joined the TradeAgent waitlist at omii-trade-agent.vercel.app.<br>
    Questions? Reply to this email.
  </p>
</div>
</body>
</html>`,
          },
        ],
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SendGrid ${resp.status}: ${body.slice(0, 200)}`);
  }
}

function json(
  body: unknown,
  status = 200,
  cors: Record<string, string> = makeCorsHeaders(null),
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
