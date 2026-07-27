/**
 * Kalshi RSA-PSS request signing — pure Web Crypto, no Deno/Supabase imports.
 * Extracted from kalshi-auth.ts (2026-07-25 incident: this logic previously
 * used HMAC-SHA256 + second-precision timestamps, which is wrong for Kalshi's
 * real scheme and shipped with zero test coverage because it lived in a file
 * that couldn't load under vitest. Kept import-free on purpose so it's
 * testable — see kalshi-signing.test.ts.
 */

// Strip PEM armor/whitespace and base64-decode to raw DER bytes.
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Kalshi issues PKCS8 RSA private keys ("-----BEGIN PRIVATE KEY-----"), which
// WebCrypto's "pkcs8" import format accepts directly. Some older keys may be
// PKCS1 ("-----BEGIN RSA PRIVATE KEY-----") — those need a fixed PKCS8 header
// wrapped around the PKCS1 body before WebCrypto will import them.
async function importKalshiPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  let der = pemToDer(pem);

  if (isPkcs1) {
    // Static PKCS8 wrapper for 2048-bit RSA (rsaEncryption OID), body length
    // patched into the two ASN.1 SEQUENCE/OCTET STRING length bytes.
    const prefix = new Uint8Array([
      0x30, 0x82, 0x00, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a,
      0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, 0x82,
      0x00, 0x00,
    ]);
    const total = prefix.length - 4 + der.length;
    const wrapped = new Uint8Array(prefix.length + der.length);
    wrapped.set(prefix, 0);
    wrapped.set(der, prefix.length);
    // Patch outer SEQUENCE length (bytes 2-3) and inner OCTET STRING length (last 2 bytes of prefix).
    wrapped[2] = (total >> 8) & 0xff;
    wrapped[3] = total & 0xff;
    wrapped[prefix.length - 2] = (der.length >> 8) & 0xff;
    wrapped[prefix.length - 1] = der.length & 0xff;
    der = wrapped;
  }

  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Kalshi requires RSA-PSS-SHA256 (salt length = digest length, i.e. 32 bytes)
// over `${timestampMs}${METHOD}${path}`, base64-encoded — NOT HMAC. See
// https://docs.kalshi.com (Authentication: RSA-PSS SHA256, MGF1/SHA256, 32-byte salt).
export async function rsaPssSha256Base64(privateKeyPem: string, message: string): Promise<string> {
  const key = await importKalshiPrivateKey(privateKeyPem);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    enc.encode(message)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function generateAuthHeaders(
  apiKeyId: string,
  privateKey: string,
  method: string,
  path: string,
  timestampMs: number
): Promise<Record<string, string>> {
  // Signature must be computed over the path only (no query string) and a
  // millisecond-precision timestamp — passing a seconds-precision timestamp
  // or hashing the query string both produce INCORRECT_API_KEY_SIGNATURE.
  const pathOnly = path.split("?")[0];
  const message = `${timestampMs}${method.toUpperCase()}${pathOnly}`;
  const signature = await rsaPssSha256Base64(privateKey, message);
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
    "Content-Type": "application/json",
  };
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
