import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  importMasterKey,
  decryptSecret,
  type EncryptedSecret,
} from "./encryption.ts";

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

/**
 * Read Kalshi live credentials for a specific user.
 *
 * Resolution order:
 *  1. Per-user encrypted row in api_keys (secret_ciphertext + secret_iv),
 *     decrypted with the master key from API_KEY_ENCRYPTION_KEY env var.
 *  2. Legacy plaintext encrypted_secret column (single-tenant only — to be
 *     removed once all rows are migrated).
 *  3. Server-wide env vars KALSHI_API_KEY_ID / KALSHI_API_PRIVATE_KEY.
 *
 * Pass userId = null for the legacy single-tenant default behavior.
 *
 * SECURITY: this function is the ONLY supported path to read Kalshi
 * credentials. Edge functions must NOT query the api_keys table directly.
 */
export async function getKalshiCredentials(
  supabase: ReturnType<typeof createClient>,
  userId: string | null = null
): Promise<{ keyId: string | null; privateKey: string | null }> {
  // Build a query that supports both per-user and legacy NULL-tenant rows.
  const query = supabase
    .from("api_keys")
    .select("key_id, secret_ciphertext, secret_iv, encrypted_secret")
    .eq("provider", "kalshi_live");

  // user_id IS NULL is the legacy default tenant. Match user_id if provided.
  const { data, error } = userId
    ? await query.eq("user_id", userId).maybeSingle()
    : await query.is("user_id", null).maybeSingle();

  if (error) {
    console.error("getKalshiCredentials query error:", error);
  }

  let keyId: string | null = data?.key_id || null;
  let privateKey: string | null = null;

  // Prefer the encrypted ciphertext column when available
  if (data?.secret_ciphertext && data?.secret_iv) {
    const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
    if (!masterKeyBase64) {
      console.error(
        "API_KEY_ENCRYPTION_KEY env var is missing. Cannot decrypt stored Kalshi credentials. " +
        "Set it to a 32-byte base64 value (openssl rand -base64 32)."
      );
    } else {
      try {
        const masterKey = await importMasterKey(masterKeyBase64);
        privateKey = await decryptSecret(
          { ciphertext: data.secret_ciphertext, iv: data.secret_iv } as EncryptedSecret,
          masterKey
        );
      } catch (e) {
        console.error(
          "Failed to decrypt Kalshi private key for user",
          userId,
          ":",
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  // Legacy plaintext fallback. Logs a warning so we know to migrate.
  if (!privateKey && data?.encrypted_secret) {
    console.warn(
      "kalshi-auth: using LEGACY plaintext encrypted_secret column for user",
      userId,
      "— migrate this row to secret_ciphertext + secret_iv ASAP"
    );
    privateKey = data.encrypted_secret;
  }

  // Server-wide env var fallback (single-tenant deployments)
  if (!keyId) keyId = Deno.env.get("KALSHI_API_KEY_ID") || null;
  if (!privateKey) privateKey = Deno.env.get("KALSHI_API_PRIVATE_KEY") || null;

  return { keyId, privateKey };
}

export const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

/**
 * Fetch with exponential backoff on 429 responses.
 * Retries up to maxRetries times before returning the final response.
 * All other status codes are returned immediately.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 429 || attempt === maxRetries) return res;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      // Network-level errors (TCP reset, connection refused, timeout) — retry before giving up.
      if (attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("fetchWithRetry: exhausted retries");
}
