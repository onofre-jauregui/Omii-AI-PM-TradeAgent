/**
 * Shared CORS headers for all Supabase Edge Functions.
 *
 * Supports multiple allowed origins via comma-separated ALLOWED_ORIGINS env var.
 * When a request Origin matches the list, that origin is reflected back (required
 * by the CORS spec — Access-Control-Allow-Origin must be a single value, not a list).
 * Falls back to "*" if ALLOWED_ORIGINS is not set (local dev).
 *
 * Two header variants:
 *  - corsHeaders:         Standard — used by most functions
 *  - corsHeadersExtended: Includes x-supabase-client-* headers — used by
 *                         functions called directly from the browser SDK
 */

const ALLOWED_ORIGINS: string[] = (() => {
  const raw = Deno.env.get("ALLOWED_ORIGINS") ?? Deno.env.get("ALLOWED_ORIGIN") ?? "";
  if (!raw) {
    if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
      console.warn("CORS: ALLOWED_ORIGINS not set — defaulting to *. Set ALLOWED_ORIGINS to your frontend domain(s).");
    }
    return ["*"];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
})();

const STANDARD_HEADERS = "authorization, x-client-info, apikey, content-type";
const EXTENDED_HEADERS =
  STANDARD_HEADERS + ", " +
  "x-supabase-client-platform, x-supabase-client-platform-version, " +
  "x-supabase-client-runtime, x-supabase-client-runtime-version";

/**
 * Resolve the correct Access-Control-Allow-Origin value for a given request.
 * If the request Origin matches our allow-list, reflect it back.
 * Otherwise return the first entry (or "*" if that's what's configured).
 */
function resolveOrigin(requestOrigin?: string | null): string {
  if (ALLOWED_ORIGINS[0] === "*") return "*";
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  // Origin not in list — return first allowed origin (browser will block, which is correct)
  return ALLOWED_ORIGINS[0];
}

/** Build CORS headers for a given request origin. */
export function makeCorsHeaders(
  requestOrigin?: string | null,
  variant: "standard" | "extended" = "standard",
): Record<string, string> {
  const origin = resolveOrigin(requestOrigin);
  const base: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": variant === "extended" ? EXTENDED_HEADERS : STANDARD_HEADERS,
  };
  if (variant === "extended") {
    base["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  return base;
}

// Static exports for backward compatibility — use the first allowed origin (or "*")
export const corsHeaders: Record<string, string> = makeCorsHeaders(null, "standard");
export const corsHeadersExtended: Record<string, string> = makeCorsHeaders(null, "extended");

/** Standard OPTIONS pre-flight response. Accepts an optional Request to reflect the origin. */
export function preflight(
  variantOrReq: "standard" | "extended" | Request = "standard",
  variant: "standard" | "extended" = "standard",
): Response {
  let resolvedVariant: "standard" | "extended" = "standard";
  let origin: string | null = null;

  if (variantOrReq instanceof Request) {
    origin = variantOrReq.headers.get("origin");
    resolvedVariant = variant;
  } else {
    resolvedVariant = variantOrReq;
  }

  return new Response(null, { headers: makeCorsHeaders(origin, resolvedVariant) });
}
