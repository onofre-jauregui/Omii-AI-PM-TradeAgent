import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// HMAC-SHA256 using built-in Web Crypto (no external imports needed)
export async function hmacSHA256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function generateAuthHeaders(
  apiKeyId: string,
  privateKey: string,
  method: string,
  path: string,
  timestamp: number
): Promise<Record<string, string>> {
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signature = await hmacSHA256Base64(privateKey, message);
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": String(timestamp),
    "Content-Type": "application/json",
  };
}

// Read Kalshi live credentials: DB api_keys table first, env var fallback
export async function getKalshiCredentials(
  supabase: ReturnType<typeof createClient>
): Promise<{ keyId: string | null; privateKey: string | null }> {
  const { data } = await supabase
    .from("api_keys")
    .select("key_id, encrypted_secret")
    .eq("provider", "kalshi_live")
    .single();

  return {
    keyId: data?.key_id || Deno.env.get("KALSHI_API_KEY_ID") || null,
    privateKey: data?.encrypted_secret || Deno.env.get("KALSHI_API_PRIVATE_KEY") || null,
  };
}

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
