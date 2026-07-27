import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL, fetchWithRetry } from "../_shared/kalshi-auth.ts";
import { makeCorsHeaders, preflight } from "../_shared/cors.ts";
import { resolveTenant } from "../_shared/tenant.ts";

// Module-level, so it resets on cold start but doesn't spam compliance_log on
// every warm-instance request — one warning per instance lifetime is enough
// to catch a silent regression back to the anonymous (rate-limited) tier.
let loggedMissingServiceKey = false;

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req, "extended");

  const corsHeaders = makeCorsHeaders(req.headers.get("origin"), "extended");

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "markets";

    // Public endpoints (market data) don't need auth
    const isPublicEndpoint =
      endpoint.startsWith("markets") || endpoint.startsWith("events") || endpoint.startsWith("series");

    const apiPath = `/trade-api/v2/${endpoint}`;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    if (!isPublicEndpoint) {
      const { userId } = await resolveTenant(req, adminClient);
      const { keyId: kalshiKeyId, privateKey: kalshiPrivateKey } =
        await getKalshiCredentials(adminClient, userId);

      if (!kalshiKeyId || !kalshiPrivateKey) {
        return new Response(
          JSON.stringify({ error: "Kalshi live API credentials not configured. Add them in Settings." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const timestamp = Date.now();
      headers = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, req.method, apiPath, timestamp);
    } else {
      // Public data doesn't require a per-user key, but signing with the
      // service-tenant credential (seeded 2026-07-14 for market-data-fetcher)
      // moves these calls off Kalshi's lowest anonymous rate tier onto the
      // authenticated tier. No key configured → fall back to unauthenticated,
      // same as before. Read-only endpoints only, so this never risks a trade.
      const { keyId: serviceKeyId, privateKey: servicePrivateKey } =
        await getKalshiCredentials(adminClient, null);
      if (serviceKeyId && servicePrivateKey) {
        const timestamp = Date.now();
        headers = await generateAuthHeaders(serviceKeyId, servicePrivateKey, req.method, apiPath, timestamp);
      } else if (!loggedMissingServiceKey) {
        loggedMissingServiceKey = true;
        await adminClient.from("compliance_log").insert({
          event_type: "kalshi_proxy_unauthenticated_fallback",
          severity: "warning",
          message: "kalshi-proxy public endpoint has no service-tenant Kalshi key — falling back to the anonymous rate tier (429-prone).",
        });
      }
    }

    const kalshiUrl = new URL(`${KALSHI_BASE_URL}/${endpoint}`);
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "endpoint") kalshiUrl.searchParams.set(key, value);
    }

    const fetchOptions: RequestInit = { method: req.method, headers };
    if (req.method === "POST" || req.method === "PUT") {
      const body = await req.text();
      if (body) fetchOptions.body = body;
    }

    const response = await fetchWithRetry(kalshiUrl.toString(), fetchOptions);
    const rawBody = await response.text();
    let data: unknown;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (parseError) {
      // Capture the actual malformed body — without this, a bad Kalshi response
      // is indistinguishable from any other exception and undiagnosable on repeat.
      const parseErrMsg = parseError instanceof Error ? parseError.message : "JSON parse failed";
      await adminClient.from("compliance_log").insert({
        event_type: "api_error",
        severity: "error",
        message: `Kalshi API returned non-JSON response on ${req.method} ${endpoint} (status ${response.status}): ${parseErrMsg}`,
        metadata: { status: response.status, endpoint, full_path: apiPath, raw_body: rawBody.slice(0, 500) },
      });
      return new Response(
        JSON.stringify({ error: "Kalshi API returned an unexpected response format", status: response.status }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!response.ok) {
      await adminClient.from("compliance_log").insert({
        event_type: "api_error",
        severity: response.status >= 500 ? "error" : "warning",
        message: `Kalshi API error on ${req.method} ${endpoint}: ${response.status}`,
        metadata: { status: response.status, response: data, endpoint, full_path: apiPath },
      });
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Internal proxy error";
    console.error("kalshi-proxy error:", error);
    // TCP-level failures (connection reset, refused, timeout) are infrastructure blips —
    // not Kalshi API errors. Classify separately so health-check doesn't alert on them.
    const isNetworkBlip = /connection reset|connection refused|timed out|network error/i.test(errMsg);
    try {
      await adminClient.from("compliance_log").insert({
        event_type: isNetworkBlip ? "kalshi_network_blip" : "api_error",
        severity: isNetworkBlip ? "info" : "error",
        message: `kalshi-proxy ${isNetworkBlip ? "network blip (after retries)" : "exception"}: ${errMsg.slice(0, 200)}`,
        metadata: { provider: "kalshi", error: errMsg },
      });
    } catch { /* never throw from catch */ }
    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
