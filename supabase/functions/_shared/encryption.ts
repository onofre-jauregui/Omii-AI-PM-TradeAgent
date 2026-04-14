/**
 * AES-GCM encryption helper for sensitive credentials at rest.
 *
 * Used to encrypt user-provided API keys (Kalshi private keys, AI provider
 * keys) before storing them in api_keys.secret_ciphertext. The master key
 * lives in the API_KEY_ENCRYPTION_KEY env var (Supabase secret) and is
 * NEVER stored in the database.
 *
 * Pure Web Crypto — works under both Deno (edge functions) and Node (vitest).
 *
 * Format:
 *  - secret_ciphertext: base64(ciphertext_bytes)
 *  - secret_iv:         base64(iv_12_bytes)
 *
 * Master key requirements:
 *  - 32 bytes (256-bit AES key)
 *  - Must be supplied as base64 in API_KEY_ENCRYPTION_KEY env var
 *  - Generate with: openssl rand -base64 32
 *
 * IMPORTANT: Rotating the master key requires re-encrypting every row in
 * api_keys. There is no built-in rotation helper yet — that's a follow-up.
 */

const ALGO = "AES-GCM";
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12;  // 96-bit nonce, the recommended size for GCM

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa is available in both Deno and modern Node (and jsdom for vitest)
  return btoa(s);
}

function base64Decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Import a base64-encoded master key into a CryptoKey usable for AES-GCM.
 * Throws if the key is missing or wrong size.
 */
export async function importMasterKey(masterKeyBase64: string): Promise<CryptoKey> {
  if (!masterKeyBase64) {
    throw new Error(
      "Missing master key. Set API_KEY_ENCRYPTION_KEY to a 32-byte base64 value (generate with: openssl rand -base64 32)"
    );
  }

  const raw = base64Decode(masterKeyBase64);
  if (raw.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Master key must be ${KEY_LENGTH_BYTES} bytes (got ${raw.length}). Generate with: openssl rand -base64 32`
    );
  }

  return await crypto.subtle.importKey(
    "raw",
    raw,
    { name: ALGO, length: 256 },
    false, // not extractable
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string;         // base64
}

/**
 * Encrypt a UTF-8 plaintext string with the given master key.
 * Generates a fresh random IV per call (REQUIRED for GCM safety).
 */
export async function encryptSecret(
  plaintext: string,
  masterKey: CryptoKey
): Promise<EncryptedSecret> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);

  const ctBuffer = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    masterKey,
    ptBytes
  );

  return {
    ciphertext: base64Encode(new Uint8Array(ctBuffer)),
    iv: base64Encode(iv),
  };
}

/**
 * Decrypt a previously-encrypted secret. Throws on tampering, wrong key,
 * wrong IV, or invalid base64.
 */
export async function decryptSecret(
  encrypted: EncryptedSecret,
  masterKey: CryptoKey
): Promise<string> {
  if (!encrypted.ciphertext || !encrypted.iv) {
    throw new Error("decryptSecret: missing ciphertext or iv");
  }

  const ct = base64Decode(encrypted.ciphertext);
  const iv = base64Decode(encrypted.iv);

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(
      `decryptSecret: iv must be ${IV_LENGTH_BYTES} bytes (got ${iv.length})`
    );
  }

  const ptBuffer = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    masterKey,
    ct
  );

  return new TextDecoder().decode(ptBuffer);
}

/**
 * Convenience helper for tests and one-off scripts. Generates a fresh
 * 32-byte AES-256 key, base64-encoded.
 */
export function generateMasterKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES));
  return base64Encode(bytes);
}
