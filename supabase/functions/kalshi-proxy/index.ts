import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const KALSHI_BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";
const KALSHI_DEMO_URL = "https://demo-api.kalshi.co/trade-api/v2";

function getKalshiBaseUrl(): string {
  const env = Deno.env.get("KALSHI_ENVIRONMENT") || "demo";
  return env === "production" ? KALSHI_BASE_URL : KALSHI_DEMO_URL;
}

// Generate Kalshi API auth headers using HMAC-SHA256
function generateAuthHeaders(
  apiKeyId: string,
  privateKey: string,
  method: string,
  path: string,
  timestamp: number
): Record<string, string> {
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signature = hmac("sha256", privateKey, message, "utf8", "base64");

  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature as string,
    "KALSHI-ACCESS-TIMESTAMP": String(timestamp),
    "Content-Type": "application/json",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "markets";

    // Public endpoints (market data) don't need auth
    const isPublicEndpoint =
      endpoint.startsWith("markets") || endpoint.startsWith("events") || endpoint.startsWith("series");

    const kalshiBase = getKalshiBaseUrl();
    const apiPath = `/trade-api/v2/${endpoint}`;

    let headers: Record<string, string> = { "Content-Type": "application/json" };

    // For authenticated endpoints, get Kalshi credentials
    if (!isPublicEndpoint) {
      const kalshiKeyId = Deno.env.get("KALSHI_API_KEY_ID");
      const kalshiPrivateKey = Deno.env.get("KALSHI_API_PRIVATE_KEY");

      if (!kalshiKeyId || !kalshiPrivateKey) {
        return new Response(
          JSON.stringify({
            error: "Kalshi API credentials not configured. Set KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY.",
          }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const timestamp = Math.floor(Date.now() / 1000);
      headers = generateAuthHeaders(
        kalshiKeyId,
        kalshiPrivateKey,
        req.method,
        apiPath,
        timestamp
      );
    }

    // Build the Kalshi API URL with query params
    const kalshiUrl = new URL(`${kalshiBase}/${endpoint}`);

    // Forward relevant query params (except our internal ones)
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "endpoint") {
        kalshiUrl.searchParams.set(key, value);
      }
    }

    // Make the request to Kalshi
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method === "POST" || req.method === "PUT") {
      const body = await req.text();
      if (body) fetchOptions.body = body;
    }

    const response = await fetch(kalshiUrl.toString(), fetchOptions);
    const data = await response.json();

    if (!response.ok) {
      // Log API errors for compliance
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      await supabase.from("compliance_log").insert({
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
