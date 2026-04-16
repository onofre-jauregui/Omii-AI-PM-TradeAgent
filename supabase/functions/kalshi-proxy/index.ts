import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateAuthHeaders, getKalshiCredentials, KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { resolveTenant } from "../_shared/tenant.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight("extended");

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "markets";

    // Public endpoints (market data) don't need auth
    const isPublicEndpoint =
      endpoint.startsWith("markets") || endpoint.startsWith("events") || endpoint.startsWith("series");

    const apiPath = `/trade-api/v2/${endpoint}`;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

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

      const timestamp = Math.floor(Date.now() / 1000);
      headers = await generateAuthHeaders(kalshiKeyId, kalshiPrivateKey, req.method, apiPath, timestamp);
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

    const response = await fetch(kalshiUrl.toString(), fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      await adminClient.from("compliance_log").insert({
        event_type: "api_error",
        severity: response.status >= 500 ? "error" : "warning",
        message: `Kalshi API error on ${req.method} ${endpoint}: ${response.status}`,
        metadata: { status: response.status, response: data, endpoint },
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
    console.error("kalshi-proxy error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Internal proxy error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
