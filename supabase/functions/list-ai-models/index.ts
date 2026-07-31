import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { makeCorsHeaders } from "../_shared/cors.ts";
import { importMasterKey, decryptSecret, type EncryptedSecret } from "../_shared/encryption.ts";

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  pricing?: { prompt: string; completion: string };
}

// Same bound as market-data-fetcher/health-check/reconcile-orders/trading-agent's
// CREDENTIAL_FETCH_TIMEOUT_MS — these are simple model-list GETs, not LLM generations.
const MODEL_LIST_TIMEOUT_MS = 8_000;

/** fetch() with an AbortController timeout; converts AbortError into a message
 *  that matches this file's existing `errors[provider] = e.message` convention. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
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
  } catch (e) {
    // Timeout or network error — conservatively mark as unavailable rather than
    // showing models the user can't actually use
    console.warn(`Provider check for ${modelId} failed:`, e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  const corsHeaders = makeCorsHeaders(req.headers.get("origin"), "extended");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // This function had no auth check at all and read api_keys with no user_id
    // filter — every caller (even unauthenticated) got a model list generated
    // from whichever provider keys happened to exist across ALL users, mixing
    // one user's paid API key/quota into another user's session. Require the
    // same bearer-JWT identity check save-ai-key uses, and scope the read to
    // that user's own rows.
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read this user's saved AI provider keys. Previously this only read the
    // legacy plaintext `encrypted_secret` column, so any key saved via
    // save-ai-key (which writes secret_ciphertext/secret_iv, encrypted_secret:
    // null) was structurally invisible here. Decrypt the ciphertext column
    // first, same resolution order as getKalshiCredentials in kalshi-auth.ts.
    const { data: keys } = await supabase
      .from("api_keys")
      .select("provider, secret_ciphertext, secret_iv, encrypted_secret")
      .eq("user_id", user.id)
      .in("provider", ["openrouter", "openai", "anthropic", "google"]);

    const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
    const masterKey = masterKeyBase64 ? await importMasterKey(masterKeyBase64) : null;

    const keyMap: Record<string, string> = {};
    for (const k of keys || []) {
      let secret: string | null = null;
      if (k.secret_ciphertext && k.secret_iv && masterKey) {
        try {
          secret = await decryptSecret(
            { ciphertext: k.secret_ciphertext, iv: k.secret_iv } as EncryptedSecret,
            masterKey
          );
        } catch (e) {
          console.error(`list-ai-models: failed to decrypt ${k.provider} key for user ${user.id}:`, e instanceof Error ? e.message : e);
        }
      }
      if (!secret && k.encrypted_secret) secret = k.encrypted_secret;
      if (secret) keyMap[k.provider] = secret;
    }

    const allModels: AIModel[] = [];
    const errors: Record<string, string> = {};
    let blockedProviders: string[] = [];

    // ── OpenRouter ─────────────────────────────────────────────
    const orKey = keyMap["openrouter"] || Deno.env.get("OPENROUTER_API_KEY");
    if (orKey) {
      try {
        const res = await fetchWithTimeout(
          "https://openrouter.ai/api/v1/models",
          { headers: { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" } },
          MODEL_LIST_TIMEOUT_MS
        );
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
        const res = await fetchWithTimeout(
          "https://api.openai.com/v1/models",
          { headers: { Authorization: `Bearer ${oaiKey}` } },
          MODEL_LIST_TIMEOUT_MS
        );
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
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${googleKey}`,
          {},
          MODEL_LIST_TIMEOUT_MS
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
    // Add direct Anthropic models when: (a) we have an API key AND (b) no Anthropic
    // models made it through OpenRouter (either no OR key, or OR has Anthropic blocked).
    const antKey = keyMap["anthropic"] || Deno.env.get("ANTHROPIC_API_KEY");
    const anthropicAlreadyInList = allModels.some(m => m.id.startsWith("anthropic/"));
    if (antKey && !anthropicAlreadyInList) {
      allModels.push(
        { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "Anthropic" },
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
