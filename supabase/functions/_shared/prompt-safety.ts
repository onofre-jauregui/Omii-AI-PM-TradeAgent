/** Default cap. Short scalar context fields (prices, tickers) never approach it. */
export const DEFAULT_FIELD_MAX_LEN = 300;

/**
 * Escapes characters that break XML tag structure and caps length.
 *
 * ESCAPE, don't strip. This function used to do `.replace(/[<>]/g, "")`, which
 * silently destroyed the meaning of every memory rule it touched: agent_memory
 * stores IF/THEN threshold rules and the comparison operator IS the rule. The
 * lesson-generation prompt in auto-reflect explicitly asks the model to produce
 * rules like "IF price>30¢ THEN REJECT" — so we were generating operators and
 * then deleting them at injection time. Measured on live data: 5 of the 8
 * highest-confidence memories contained < or >, and each reached the LLM
 * mangled, e.g.
 *   "IF true_p < 0.15 AND implied > 0.25 THEN REJECT"
 *     -> "IF true_p  0.1 AND implied probability  50% THEN REJECT"
 * Escaping preserves both XML safety and meaning: the payload can no longer
 * close a <field> tag, and the model reads &lt;/&gt; as the operators they are.
 *
 * Order matters — & must be escaped first, or the ampersand of an entity we
 * just emitted would itself be re-escaped into &amp;lt;.
 */
export function sanitizeMarketData(
  value: unknown,
  maxLen: number = DEFAULT_FIELD_MAX_LEN,
): string {
  const escaped = String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  if (escaped.length <= maxLen) return escaped;

  // Truncation is a silent correctness bug when it hits a multi-record field:
  // the S-001 memory block runs ~900 chars against the old flat 300-char cap,
  // so 3 of 5 memories vanished with no signal anywhere. Mark the cut so it is
  // visible in logged prompts instead of looking like the whole input.
  return escaped.slice(0, maxLen) + `…[truncated ${escaped.length - maxLen} chars]`;
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
