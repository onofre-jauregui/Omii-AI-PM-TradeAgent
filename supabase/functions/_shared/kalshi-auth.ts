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

const EQUITY_FETCH_TIMEOUT_MS = 8_000;

/**
 * Real current Kalshi account equity — cash balance + value of open positions,
 * both from GET /portfolio/balance. This is the correct denominator for
 * concentration-style risk checks: a high-water-mark peak never drops after a
 * loss, so sizing against it understates how much of the ACTUAL account a
 * trade commits post-drawdown.
 *
 * Returns null on any credential/network failure — callers should treat null
 * as "fall back to whatever the caller already had" (e.g. peak_portfolio_value),
 * not as a reason to block trading. This is a risk-tightening signal, not a
 * required dependency.
 */
export async function fetchLiveEquityUsd(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
  { generateAuthHeaders, KALSHI_BASE_URL }: {
    generateAuthHeaders: (keyId: string, privateKey: string, method: string, path: string, ts: number) => Promise<Record<string, string>>;
    KALSHI_BASE_URL: string;
  }
): Promise<number | null> {
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`credential fetch exceeded ${EQUITY_FETCH_TIMEOUT_MS}ms`)), EQUITY_FETCH_TIMEOUT_MS);
    });
    let keyId: string | null, privateKey: string | null;
    try {
      ({ keyId, privateKey } = await Promise.race([getKalshiCredentials(supabase, userId), timeout]));
    } finally {
      clearTimeout(timeoutId);
    }
    if (!keyId || !privateKey) return null;

    const path = "/trade-api/v2/portfolio/balance";
    const headers = await generateAuthHeaders(keyId, privateKey, "GET", path, Date.now());
    const controller = new AbortController();
    const balanceTimeoutId = setTimeout(() => controller.abort(), EQUITY_FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${KALSHI_BASE_URL}/portfolio/balance`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(balanceTimeoutId);
    }
    if (!resp.ok) {
      console.error("fetchLiveEquityUsd: Kalshi balance fetch failed", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const data = await resp.json();
    const cashUsd = (data?.balance ?? 0) / 100;
    const positionsUsd = (data?.portfolio_value ?? 0) / 100;
    return cashUsd + positionsUsd;
  } catch (e) {
    console.error("fetchLiveEquityUsd failed for user", userId, ":", e instanceof Error ? e.message : e);
    return null;
  }
}
