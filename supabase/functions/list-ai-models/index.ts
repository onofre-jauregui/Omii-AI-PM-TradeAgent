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

/** Test whether a model's provider is allowed by the account's data policy.
 *  Uses max_tokens:1 — the "no allowed providers" error fires at the routing
 *  layer before any tokens are generated, so blocked models cost $0. */
async function isProviderAvailable(
  modelId: string,
  apiKey: string
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "." }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) return true;

    const body = await res.json().catch(() => ({}));
    const msg: string = body?.error?.message || "";
    // These errors mean the account's data policy blocks the providers for this model
    if (
      msg.includes("No allowed providers") ||
      msg.includes("No endpoints available matching your guardrail") ||
      msg.includes("No endpoints found")
    ) {
      return false;
    }
    // Any other error (rate limit, bad request, etc.) means the provider exists
    return true;
  } catch {
    clearTimeout(timeout);
    return true; // network/timeout — assume available
  }
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
    let blockedProviders: string[] = [];

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
            .sort((a: any, b: any) => (a.name || a.id).localeCompare(b.name || b.id))
            .slice(0, 200)
            .map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              provider: "OpenRouter",
              contextLength: m.context_length,
              pricing: m.pricing,
            }));

          // Group by provider prefix (e.g., "openai", "google", "anthropic", "meta-llama")
          const prefixGroups = new Map<string, AIModel[]>();
          for (const m of models) {
            const prefix = m.id.split("/")[0];
            if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
            prefixGroups.get(prefix)!.push(m);
          }

          // Test one model per prefix in parallel
          const checks = await Promise.allSettled(
            Array.from(prefixGroups.entries()).map(async ([prefix, group]) => {
              const available = await isProviderAvailable(group[0].id, orKey);
              return { prefix, available };
            })
          );

          const blocked = new Set<string>();
          for (const r of checks) {
            if (r.status === "fulfilled" && !r.value.available) {
              blocked.add(r.value.prefix);
            }
          }
          blockedProviders = Array.from(blocked);

          // Filter to only available providers
          const filtered = models.filter((m) => {
            const prefix = m.id.split("/")[0];
            return !blocked.has(prefix);
          });

          allModels.push(...filtered);
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
      const hint = blockedProviders.length > 0
        ? ` Your OpenRouter data policy blocks these providers: ${blockedProviders.join(", ")}. Update at https://openrouter.ai/settings/privacy`
        : "";
      return new Response(
        JSON.stringify({
          models: [],
          error: `No available AI models.${hint}`,
          blockedProviders,
          errors,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ models: allModels, blockedProviders, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("list-ai-models error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
