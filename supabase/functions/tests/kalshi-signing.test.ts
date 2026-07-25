// @vitest-environment node
//
// This suite needs Node's real crypto.subtle (RSA-PSS key import/sign/verify).
// The project's default vitest environment is jsdom (vitest.config.ts) for
// component tests; jsdom's Crypto shim lacks a working `subtle`, so
// importKey() rejected valid PKCS8 ArrayBuffers with a bogus type error.
// This file has no DOM dependency, so overriding to "node" here is safe and
// doesn't touch the global config other suites rely on.
import { describe, it, expect } from "vitest";
import { generateAuthHeaders, rsaPssSha256Base64 } from "../_shared/kalshi-signing";

// Regression guard for the 2026-07-25 incident: kalshi-auth.ts signed requests
// with HMAC-SHA256 over a second-precision timestamp. Kalshi requires
// RSA-PSS-SHA256 (salt length 32) over a millisecond-precision timestamp, and
// the mismatch was invisible for months because the old order endpoint
// short-circuited on a 410 "deprecated" response before Kalshi ever validated
// the signature. Every live trade attempt (60/60) failed until this was fixed.

function toPem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

async function generateTestKeyPair() {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  return { publicKey: kp.publicKey, privateKeyPem: toPem(pkcs8) };
}

async function verifyRsaPss(publicKey: CryptoKey, message: string, sigB64: string): Promise<boolean> {
  const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  return crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    publicKey,
    sig,
    new TextEncoder().encode(message)
  );
}

describe("Kalshi request signing", () => {
  it("produces an RSA-PSS-SHA256 signature verifiable against the matching public key", async () => {
    const { publicKey, privateKeyPem } = await generateTestKeyPair();
    const timestampMs = 1784992654123; // 13-digit ms timestamp, fixed for determinism
    const path = "/trade-api/v2/portfolio/events/orders";

    const headers = await generateAuthHeaders("test-key-id", privateKeyPem, "POST", path, timestampMs);
    const ok = await verifyRsaPss(publicKey, `${timestampMs}POST${path}`, headers["KALSHI-ACCESS-SIGNATURE"]);

    expect(ok).toBe(true);
  });

  it("signature is 256 bytes (RSA-2048), not HMAC-SHA256's 32-byte digest", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const sigB64 = await rsaPssSha256Base64(privateKeyPem, "hello");
    expect(atob(sigB64).length).toBe(256);
  });

  it("uses the caller-supplied timestamp verbatim as the header value (caller must pass ms, not seconds)", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const timestampMs = Date.now();
    const headers = await generateAuthHeaders("test-key-id", privateKeyPem, "GET", "/trade-api/v2/portfolio/balance", timestampMs);
    expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe(String(timestampMs));
    expect(headers["KALSHI-ACCESS-TIMESTAMP"].length).toBe(13); // ms-precision epoch is 13 digits until year 2286
  });

  it("strips the query string from the signed path", async () => {
    const { publicKey, privateKeyPem } = await generateTestKeyPair();
    const timestampMs = 1784992654123;
    const path = "/trade-api/v2/portfolio/orders";

    const headers = await generateAuthHeaders("test-key-id", privateKeyPem, "GET", `${path}?limit=5`, timestampMs);
    const ok = await verifyRsaPss(publicKey, `${timestampMs}GET${path}`, headers["KALSHI-ACCESS-SIGNATURE"]);

    expect(ok).toBe(true);
  });
});
