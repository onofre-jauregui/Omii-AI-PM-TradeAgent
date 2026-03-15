import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, strategies, model, temperature, systemPrompt } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // Build strategy context from active strategies
    let strategyBlock = "";
    if (strategies && strategies.length > 0) {
      strategyBlock = "\n\n## Active Trading Strategies\nYou MUST follow these strategy instructions when analyzing markets and suggesting trades:\n\n";
      for (const s of strategies) {
        strategyBlock += `### ${s.name}\n${s.instructions}\n\n`;
      }
      strategyBlock += "When suggesting trades, always reference which strategy (or combination) you are applying and why.\n";
    }

    const baseSystemPrompt = systemPrompt || `You are an expert algorithmic trading agent for prediction markets (Polymarket). You analyze market data, news sentiment, and probability shifts to identify profitable trading opportunities.

Consider:
- Market liquidity and volume
- Historical price patterns
- News catalysts and timing
- Risk/reward ratios
- Correlation with other markets

Provide clear trade signals with entry/exit prices and confidence levels. Format responses with markdown for clarity.`;

    const fullSystemPrompt = baseSystemPrompt + strategyBlock;

    // Map model IDs to gateway model names
    const modelMap: Record<string, string> = {
      "gemini-flash": "google/gemini-3-flash-preview",
      "gemini-pro": "google/gemini-2.5-pro",
      "gpt5": "openai/gpt-5",
      "gpt5-mini": "openai/gpt-5-mini",
    };

    const resolvedModel = modelMap[model] || "google/gemini-3-flash-preview";

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: "system", content: fullSystemPrompt },
          ...messages,
        ],
        stream: true,
        temperature: temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please wait a moment and try again." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Usage credits depleted. Please add credits to continue." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("trading-agent error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
