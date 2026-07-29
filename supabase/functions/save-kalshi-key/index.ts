import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { importMasterKey, encryptSecret } from "../_shared/encryption.ts";
import { generateAuthHeaders } from "../_shared/kalshi-auth.ts";

// Same 8s bound as the CREDENTIAL_FETCH_TIMEOUT_MS convention used across
// market-data-fetcher/auto-trade/settle-signals/etc — applied to the
// non-blocking username backfill below (last Tier-5 unguarded fetch,
// health-check 76th run's audit backlog).
const KALSHI_USERNAME_FETCH_TIMEOUT_MS = 8_000;

/**
 * save-kalshi-key: Securely saves a user's Kalshi API credentials.
 *
 * - Reads user identity from the Authorization JWT (never trusts client-supplied user_id)
 * - Encrypts the private key with AES-256-GCM using API_KEY_ENCRYPTION_KEY
 * - Stores ciphertext + iv in secret_ciphertext + secret_iv columns with the user's id
 * - Removes any legacy plaintext row that may exist for this user
 */

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight(req);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Verify caller identity via JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return new Response(JSON.stringify({ ok: false, error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { key_id, private_key } = await req.json();
    if (!key_id || !private_key) {
      return new Response(JSON.stringify({ ok: false, error: "key_id and private_key are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Encrypt the private key
    const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
    if (!masterKeyBase64) {
      return new Response(JSON.stringify({ ok: false, error: "Server encryption key not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const masterKey = await importMasterKey(masterKeyBase64);
    const { ciphertext, iv } = await encryptSecret(private_key.trim(), masterKey);

    // Delete any existing row for this user+provider, then insert fresh.
    // (No unique(user_id, provider) constraint exists yet — delete+insert is safest.)
    await supabase
      .from("api_keys")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", "kalshi_live");

    const { error: insertErr } = await supabase
      .from("api_keys")
      .insert({
        user_id: user.id,
        provider: "kalshi_live",
        key_id: key_id.trim(),
        secret_ciphertext: ciphertext,
        secret_iv: iv,
        encrypted_secret: null,
        updated_at: new Date().toISOString(),
      });

    if (insertErr) {
      console.error("save-kalshi-key insert error:", insertErr);
      return new Response(JSON.stringify({ ok: false, error: insertErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Non-blocking: fetch Kalshi username and cache on profile.
    // Key save already succeeded above — this failure must not affect the response.
    fetchAndStoreKalshiUsername(supabase, user.id, key_id.trim(), private_key.trim())
      .catch((e: Error) => console.warn("kalshi username fetch failed (non-critical):", e.message));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("save-kalshi-key error:", e);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchAndStoreKalshiUsername(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  keyId: string,
  privateKey: string,
): Promise<void> {
  const path = "/trade-api/v2/portfolio/members/me";
  const timestamp = Date.now();
  const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, timestamp);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), KALSHI_USERNAME_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`https://api.elections.kalshi.com${path}`, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    console.warn(`kalshi username fetch returned ${resp.status} — skipping`);
    return;
  }
  const data = await resp.json();
  const username: string | null = data?.member?.user_name ?? data?.member_id ?? null;
  if (!username) return;
  await supabase.from("profiles").update({ kalshi_username: username }).eq("id", userId);
}
