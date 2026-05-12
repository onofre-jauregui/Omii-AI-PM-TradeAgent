import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { importMasterKey, encryptSecret } from "../_shared/encryption.ts";

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
