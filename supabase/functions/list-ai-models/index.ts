import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  pricing?: { prompt: string; completion: string };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Read all saved AI provider keys from DB
    const { data: keys } = await supabase
      .from("api_keys")
      .select("provider, encrypted_secret")
      .in("provider", ["openrouter", "openai", "anthropic", "google"]);

    const keyMap: Record<string, string> = {};
    for (const k of keys || []) {
      if (k.encrypted_secret) keyMap[k.provider] = k.encrypted_secret;
    }

    const allModels: AIModel[] = [];
    const errors: Record<string, string> = {};

    // ── OpenRouter ─────────────────────────────────────────────
    const orKey = keyMap["openrouter"] || Deno.env.get("OPENROUTER_API_KEY");
    if (orKey) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" },
        });
        if (res.ok) {
          const data = await res.json();
          const models: AIModel[] = (data.data || [])
            .filter((m: any) => (m.context_length || 0) >= 32768)
            .sort((a: any, b: any) => {
              // Sort by name for readability
              return (a.name || a.id).localeCompare(b.name || b.id);
            })
            .slice(0, 100)
            .map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              provider: "OpenRouter",
              contextLength: m.context_length,
              pricing: m.pricing,
            }));
          allModels.push(...models);
        } else {
          errors["openrouter"] = `HTTP ${res.status}`;
        }
      } catch (e: any) {
        errors["openrouter"] = e.message;
        console.error("OpenRouter model fetch failed:", e);
      }
    }

    // ── OpenAI (only fetch directly if no OpenRouter key) ──────
    const oaiKey = keyMap["openai"] || Deno.env.get("OPENAI_API_KEY");
    if (oaiKey && !orKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${oaiKey}` },
        });
        if (res.ok) {
          const data = await res.json();
          const models: AIModel[] = (data.data || [])
            .filter((m: any) =>
              m.id.includes("gpt") || m.id.startsWith("o1") || m.id.startsWith("o3") || m.id.startsWith("o4")
            )
            .sort((a: any, b: any) => b.created - a.created)
            .slice(0, 20)
            .map((m: any) => ({ id: m.id, name: m.id, provider: "OpenAI" }));
          allModels.push(...models);
        } else {
          errors["openai"] = `HTTP ${res.status}`;
        }
      } catch (e: any) {
        errors["openai"] = e.message;
      }
    }

    // ── Google AI (only fetch directly if no OpenRouter key) ───
    const googleKey = keyMap["google"] || Deno.env.get("GOOGLE_AI_API_KEY");
    if (googleKey && !orKey) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${googleKey}`
        );
        if (res.ok) {
          const data = await res.json();
          const models: AIModel[] = (data.models || [])
            .filter(
              (m: any) =>
                m.name.includes("gemini") &&
                m.supportedGenerationMethods?.includes("generateContent")
            )
            .map((m: any) => ({
              id: m.name.replace("models/", ""),
              name: m.displayName || m.name.replace("models/", ""),
              provider: "Google",
            }));
          allModels.push(...models);
        } else {
          errors["google"] = `HTTP ${res.status}`;
        }
      } catch (e: any) {
        errors["google"] = e.message;
      }
    }

    // ── Anthropic (no list endpoint — hardcode latest) ─────────
    const antKey = keyMap["anthropic"] || Deno.env.get("ANTHROPIC_API_KEY");
    if (antKey && !orKey) {
      allModels.push(
        { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic" },
        { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "Anthropic" }
      );
    }

    if (allModels.length === 0) {
      return new Response(
        JSON.stringify({
          models: [],
          error: "No AI provider keys found. Save an API key in Settings first.",
          errors,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ models: allModels, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("list-ai-models error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
