import { describe, it, expect, beforeAll } from "vitest";
import {
  importMasterKey,
  encryptSecret,
  decryptSecret,
  generateMasterKeyBase64,
} from "./encryption";

let masterKeyBase64: string;
let masterKey: CryptoKey;

beforeAll(async () => {
  masterKeyBase64 = generateMasterKeyBase64();
  masterKey = await importMasterKey(masterKeyBase64);
});

describe("encryption helper", () => {
  describe("master key handling", () => {
    it("generates a fresh 32-byte base64 key", () => {
      const k = generateMasterKeyBase64();
      // 32 bytes base64 = 44 chars (with padding)
      expect(k).toHaveLength(44);
      // Should be valid base64
      expect(() => atob(k)).not.toThrow();
    });

    it("rejects empty master key", async () => {
      await expect(importMasterKey("")).rejects.toThrow(/Missing master key/);
    });

    it("rejects wrong-size master key", async () => {
      // 16 bytes, not 32
      const tooShort = btoa("a".repeat(16));
      await expect(importMasterKey(tooShort)).rejects.toThrow(/32 bytes/);
    });

    it("imports a valid 32-byte key", async () => {
      const k = await importMasterKey(generateMasterKeyBase64());
      expect(k).toBeDefined();
    });
  });

  describe("encrypt + decrypt round trip", () => {
    it("round-trips a typical Kalshi private key string", async () => {
      const plaintext =
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFA...\n-----END PRIVATE KEY-----";
      const encrypted = await encryptSecret(plaintext, masterKey);
      const decrypted = await decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips a short API key", async () => {
      const plaintext = "sk-proj-1234567890abcdef";
      const encrypted = await encryptSecret(plaintext, masterKey);
      const decrypted = await decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips Unicode strings", async () => {
      const plaintext = "secret-with-emoji-and-üñîçødé";
      const encrypted = await encryptSecret(plaintext, masterKey);
      const decrypted = await decryptSecret(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it("uses a fresh random IV for each call (no key+IV reuse)", async () => {
      const plaintext = "same-secret";
      const a = await encryptSecret(plaintext, masterKey);
      const b = await encryptSecret(plaintext, masterKey);
      // IVs MUST differ — reuse with the same key is a critical GCM bug
      expect(a.iv).not.toBe(b.iv);
      // Ciphertexts will also differ as a consequence
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it("produces base64 output", async () => {
      const encrypted = await encryptSecret("test", masterKey);
      expect(() => atob(encrypted.ciphertext)).not.toThrow();
      expect(() => atob(encrypted.iv)).not.toThrow();
    });
  });

  describe("input validation", () => {
    it("rejects empty plaintext", async () => {
      await expect(encryptSecret("", masterKey)).rejects.toThrow(
        /non-empty string/
      );
    });

    it("rejects decryption with missing ciphertext", async () => {
      await expect(
        decryptSecret({ ciphertext: "", iv: "abc" }, masterKey)
      ).rejects.toThrow(/missing ciphertext or iv/);
    });

    it("rejects decryption with missing iv", async () => {
      await expect(
        decryptSecret({ ciphertext: "abc", iv: "" }, masterKey)
      ).rejects.toThrow(/missing ciphertext or iv/);
    });

    it("rejects decryption with wrong-size iv", async () => {
      // 8 bytes encoded — not 12
      const badIv = btoa("aaaaaaaa");
      await expect(
        decryptSecret({ ciphertext: "abc", iv: badIv }, masterKey)
      ).rejects.toThrow(/iv must be/);
    });
  });

  describe("authentication / tamper detection", () => {
    it("fails to decrypt with the wrong master key", async () => {
      const otherKey = await importMasterKey(generateMasterKeyBase64());
      const encrypted = await encryptSecret("secret", masterKey);
      await expect(decryptSecret(encrypted, otherKey)).rejects.toThrow();
    });

    it("fails to decrypt tampered ciphertext", async () => {
      const encrypted = await encryptSecret("secret", masterKey);
      // Flip a bit in the middle of the ciphertext
      const ctBytes = atob(encrypted.ciphertext);
      const mid = Math.floor(ctBytes.length / 2);
      const tampered =
        ctBytes.slice(0, mid) +
        String.fromCharCode(ctBytes.charCodeAt(mid) ^ 0xff) +
        ctBytes.slice(mid + 1);
      const tamperedB64 = btoa(tampered);
      await expect(
        decryptSecret({ ciphertext: tamperedB64, iv: encrypted.iv }, masterKey)
      ).rejects.toThrow();
    });
  });
});
