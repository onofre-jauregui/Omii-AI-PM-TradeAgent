import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { importMasterKey, encryptSecret } from "../_shared/encryption.ts";

const VALID_PROVIDERS = new Set(["openrouter", "openai", "anthropic", "google"]);

/**
 * save-ai-key: Securely saves a user's AI provider API key.
 *
 * Mirrors save-kalshi-key — never trusts a client-supplied user_id.
 * Encrypts the API key with AES-256-GCM before storing, same as Kalshi keys.
 *
 * Accepts: { provider: "openrouter" | "openai" | "anthropic" | "google", api_key: string }
 * Requires: Authorization: Bearer <jwt>
 */

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight(req);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Verify caller identity via JWT — never trust client-supplied user_id
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

    const { provider, api_key } = await req.json();

    if (!provider || !VALID_PROVIDERS.has(provider)) {
      return new Response(JSON.stringify({ ok: false, error: `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!api_key || typeof api_key !== "string" || !api_key.trim()) {
      return new Response(JSON.stringify({ ok: false, error: "api_key is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Encrypt with AES-256-GCM
    const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
    if (!masterKeyBase64) {
      return new Response(JSON.stringify({ ok: false, error: "Server encryption key not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const masterKey = await importMasterKey(masterKeyBase64);
    const { ciphertext, iv } = await encryptSecret(api_key.trim(), masterKey);

    // Delete existing row, then insert fresh (same pattern as save-kalshi-key)
    await supabase
      .from("api_keys")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", provider);

    const { error: insertErr } = await supabase
      .from("api_keys")
      .insert({
        user_id: user.id,
        provider,
        key_id: "default",
        secret_ciphertext: ciphertext,
        secret_iv: iv,
        encrypted_secret: null,
        updated_at: new Date().toISOString(),
      });

    if (insertErr) {
      console.error(`save-ai-key insert error (${provider}):`, insertErr);
      return new Response(JSON.stringify({ ok: false, error: insertErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("save-ai-key error:", e);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
