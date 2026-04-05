import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

// HMAC-SHA256 using built-in Web Crypto (no external imports needed)
async function hmacSHA256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function generateAuthHeaders(
  apiKeyId: string,
  privateKey: string,
  method: string,
  path: string,
  timestamp: number
): Promise<Record<string, string>> {
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signature = await hmacSHA256Base64(privateKey, message);
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
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

    const apiPath = `/trade-api/v2/${endpoint}`;
    let headers: Record<string, string> = { "Content-Type": "application/json" };

    if (!isPublicEndpoint) {
      const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { data: keyRow } = await adminClient
        .from("api_keys")
        .select("key_id, encrypted_secret")
        .eq("provider", "kalshi_live")
        .single();

      const kalshiKeyId = keyRow?.key_id || Deno.env.get("KALSHI_API_KEY_ID");
      const kalshiPrivateKey = keyRow?.encrypted_secret || Deno.env.get("KALSHI_API_PRIVATE_KEY");

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
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
