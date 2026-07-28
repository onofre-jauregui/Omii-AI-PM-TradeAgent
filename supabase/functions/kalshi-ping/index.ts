import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { getKalshiCredentials, generateAuthHeaders, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";

const CREDENTIAL_FETCH_TIMEOUT_MS = 8_000; // matches market-data-fetcher's REQUEST_TIMEOUT_MS

/**
 * kalshi-ping: Validates a user's Kalshi API key by hitting GET /portfolio/balance.
 * Used in the onboarding flow to confirm credentials work before the agent starts.
 * Returns { ok: boolean, balance_usd?: number, error?: string }
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return json({ ok: false, error: "Missing server credentials" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? supabaseKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: "Unauthorized" }, 401);

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Bare `await` here would hang the whole request forever on a stalled query —
  // same class of unguarded-credential-fetch bug fixed in market-data-fetcher,
  // health-check, reconcile-orders, and settle-signals. This endpoint is called
  // synchronously from the onboarding wizard, so a hang here leaves the user's
  // "verify Kalshi key" step spinning indefinitely with no error surfaced.
  let keyId: string | null, privateKey: string | null;
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`credential fetch exceeded ${CREDENTIAL_FETCH_TIMEOUT_MS}ms`)),
        CREDENTIAL_FETCH_TIMEOUT_MS
      );
    });
    try {
      ({ keyId, privateKey } = await Promise.race([getKalshiCredentials(supabase, user.id), timeout]));
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("kalshi-ping: credential fetch failed or timed out:", msg);
    return json({ ok: false, error: "Could not verify credentials right now — please try again." });
  }

  if (!keyId || !privateKey) {
    return json({ ok: false, error: "No Kalshi API key found. Save your credentials in Settings first." });
  }

  try {
    const path = "/trade-api/v2/portfolio/balance";
    const timestamp = Date.now();
    const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, timestamp);

    const resp = await fetch(`https://api.elections.kalshi.com${path}`, { headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn("kalshi-ping: Kalshi returned", resp.status, body.slice(0, 200));
      return json({ ok: false, error: `Kalshi returned ${resp.status} — check your API key ID and private key.` });
    }

    const data = await resp.json();
    const balanceCents = data?.balance ?? 0;
    return json({ ok: true, balance_usd: balanceCents / 100 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("kalshi-ping error:", msg);
    return json({ ok: false, error: msg });
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
