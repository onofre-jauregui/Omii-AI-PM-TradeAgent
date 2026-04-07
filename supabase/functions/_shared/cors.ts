/**
 * Shared CORS headers for all Supabase Edge Functions.
 *
 * Two variants:
 *  - corsHeaders:         Standard — used by most functions
 *  - corsHeadersExtended: Includes x-supabase-client-* headers — used by
 *                         functions called directly from the browser SDK
 */

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export const corsHeadersExtended: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, " +
    "x-supabase-client-platform, x-supabase-client-platform-version, " +
    "x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

/** Standard OPTIONS pre-flight response. */
export function preflight(variant: "standard" | "extended" = "standard"): Response {
  return new Response(null, {
    headers: variant === "extended" ? corsHeadersExtended : corsHeaders,
  });
}
