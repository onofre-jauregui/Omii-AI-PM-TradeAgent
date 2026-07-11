// Strips characters that break XML tag structure and caps length.
export function sanitizeMarketData(value: unknown): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .slice(0, 300);
}

// Validates that the LLM's qualify response matches the expected format.
// Returns the parsed decision or null if the response is malformed.
export function parseQualifyResponse(text: string): { decision: "QUALIFY" | "REJECT"; reason: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(QUALIFY|REJECT)\s*[\n\r]+Reason:\s*(.+)/is);
  if (!match) return null;
  return {
    decision: match[1].toUpperCase() as "QUALIFY" | "REJECT",
    reason: match[2].trim().slice(0, 300),
  };
}

// Scrubs PII and secrets from an object before logging.
// Replaces API keys, email addresses, and UUIDs-in-key-positions with redacted markers.
export function scrubbedForLog(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return scrubString(obj);
  if (Array.isArray(obj)) return obj.map(scrubbedForLog);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("key") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("token") ||
        lowerKey.includes("password") ||
        lowerKey.includes("private")
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = scrubbedForLog(value);
      }
    }
    return result;
  }
  return obj;
}

function scrubString(value: string): string {
  // Redact email addresses
  let out = value.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");
  // Redact long hex strings that look like API keys (32+ hex chars)
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, "[HEX_KEY]");
  // Redact JWT-like tokens (three base64 segments separated by dots)
  out = out.replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, "[JWT]");
  return out;
}
