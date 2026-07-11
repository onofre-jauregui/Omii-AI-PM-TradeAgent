import { describe, it, expect } from "vitest";
import { sanitizeMarketData, parseQualifyResponse, scrubbedForLog } from "./prompt-safety.ts";

describe("sanitizeMarketData", () => {
  it("strips < and > characters", () => {
    expect(sanitizeMarketData("<script>alert(1)</script>")).toBe("scriptalert(1)/script");
  });

  it("caps at 300 characters", () => {
    expect(sanitizeMarketData("x".repeat(500))).toHaveLength(300);
  });

  it("handles non-string input", () => {
    expect(sanitizeMarketData(null)).toBe("");
    expect(sanitizeMarketData(undefined)).toBe("");
    expect(sanitizeMarketData(42)).toBe("42");
  });
});

describe("parseQualifyResponse", () => {
  it("parses a valid QUALIFY response", () => {
    const result = parseQualifyResponse("QUALIFY\nReason: Strong signal on KXBTC");
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("QUALIFY");
    expect(result!.reason).toContain("Strong signal");
  });

  it("parses a valid REJECT response", () => {
    const result = parseQualifyResponse("REJECT\nReason: Insufficient edge");
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("REJECT");
  });

  it("returns null for malformed output", () => {
    expect(parseQualifyResponse("I think you should buy")).toBeNull();
    expect(parseQualifyResponse("QUALIFY — great trade")).toBeNull();
    expect(parseQualifyResponse("")).toBeNull();
  });

  it("is case-insensitive for QUALIFY/REJECT", () => {
    const result = parseQualifyResponse("qualify\nReason: test");
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("QUALIFY");
  });

  it("caps reason at 300 characters", () => {
    const long = "x".repeat(500);
    const result = parseQualifyResponse(`QUALIFY\nReason: ${long}`);
    expect(result!.reason).toHaveLength(300);
  });
});

describe("scrubbedForLog", () => {
  it("redacts keys named 'key', 'secret', 'token', 'password', 'private'", () => {
    const input = {
      api_key: "sk-abcdef1234567890abcdef1234567890",
      secret: "mysecretvalue",
      token: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
      password: "hunter2",
      private_key: "-----BEGIN EC PRIVATE KEY-----",
      name: "should-stay",
    };
    const out = scrubbedForLog(input) as Record<string, unknown>;
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.private_key).toBe("[REDACTED]");
    expect(out.name).toBe("should-stay");
  });

  it("redacts email addresses in string values", () => {
    const out = scrubbedForLog({ message: "Error for user@example.com" }) as Record<string, unknown>;
    expect(out.message).not.toContain("user@example.com");
    expect(out.message).toContain("[EMAIL]");
  });

  it("redacts JWT tokens in string values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = scrubbedForLog({ message: `Bearer ${jwt}` }) as Record<string, unknown>;
    expect(out.message).not.toContain("eyJhbGci");
    expect(out.message).toContain("[JWT]");
  });

  it("redacts long hex strings (API key pattern)", () => {
    const out = scrubbedForLog({ msg: "key=abcdef1234567890abcdef1234567890ab" }) as Record<string, unknown>;
    expect(out.msg).toContain("[HEX_KEY]");
  });

  it("handles null and undefined gracefully", () => {
    expect(scrubbedForLog(null)).toBeNull();
    expect(scrubbedForLog(undefined)).toBeUndefined();
  });

  it("recurses into nested objects", () => {
    const input = { outer: { secret: "mysecret", safe: "yes" } };
    const out = scrubbedForLog(input) as Record<string, Record<string, unknown>>;
    expect(out.outer.secret).toBe("[REDACTED]");
    expect(out.outer.safe).toBe("yes");
  });

  it("handles arrays", () => {
    const out = scrubbedForLog([{ token: "abc" }, { name: "safe" }]) as Array<Record<string, unknown>>;
    expect(out[0].token).toBe("[REDACTED]");
    expect(out[1].name).toBe("safe");
  });
});
