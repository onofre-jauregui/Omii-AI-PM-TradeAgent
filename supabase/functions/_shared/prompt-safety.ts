/**
 * Strips characters that break XML tag structure and caps length.
 * Kalshi market titles never exceed 150 chars in practice; 300 is a hard ceiling.
 */
export function sanitizeMarketData(value: unknown): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .slice(0, 300);
}

/**
 * Validates that the LLM's qualify response matches the expected format.
 * Returns the parsed decision or null if the response is malformed — the
 * caller should treat null as REJECT and log a prompt_injection_suspected event.
 */
export function parseQualifyResponse(text: string): { decision: "QUALIFY" | "REJECT"; reason: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(QUALIFY|REJECT)\s*[\n\r]+Reason:\s*(.+)/is);
  if (!match) return null;
  return {
    decision: match[1].toUpperCase() as "QUALIFY" | "REJECT",
    reason: match[2].trim().slice(0, 300),
  };
}
