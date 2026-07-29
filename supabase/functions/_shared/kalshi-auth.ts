import { createClient } from "npm:@supabase/supabase-js@2";
import {
  importMasterKey,
  decryptSecret,
  type EncryptedSecret,
} from "./encryption.ts";

export {
  rsaPssSha256Base64,
  generateAuthHeaders,
  KALSHI_BASE_URL,
  fetchWithRetry,
} from "./kalshi-signing.ts";

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
