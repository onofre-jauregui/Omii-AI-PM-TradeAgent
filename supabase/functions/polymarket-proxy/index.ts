import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "events";
    const limit = url.searchParams.get("limit") || "20";
    const slug = url.searchParams.get("slug") || "";
    const id = url.searchParams.get("id") || "";
    const tag = url.searchParams.get("tag") || "";

    let apiUrl = "";

    if (endpoint === "events") {
      apiUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
      if (tag) apiUrl += `&tag=${tag}`;
    } else if (endpoint === "event" && (id || slug)) {
      apiUrl = id
        ? `https://gamma-api.polymarket.com/events/${id}`
        : `https://gamma-api.polymarket.com/events/slug/${slug}`;
    } else if (endpoint === "markets") {
      apiUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
    } else if (endpoint === "market" && id) {
      apiUrl = `https://gamma-api.polymarket.com/markets/${id}`;
    } else if (endpoint === "tags") {
      apiUrl = `https://gamma-api.polymarket.com/tags`;
    } else {
      return new Response(JSON.stringify({ error: "Invalid endpoint" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const response = await fetch(apiUrl);
    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("polymarket-proxy error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Internal proxy error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
