import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const TRADE_TOOL = {
  type: "function",
  function: {
    name: "execute_trade",
    description: "Execute a trade on a prediction market. Use this when the user asks you to trade, buy, sell, or take a position on a market. Always confirm the trade details before executing.",
    parameters: {
      type: "object",
      properties: {
        marketId: { type: "string", description: "The market ID to trade on" },
        marketQuestion: { type: "string", description: "The market question/title" },
        side: { type: "string", enum: ["yes", "no"], description: "Whether to trade YES or NO" },
        action: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
        price: { type: "number", description: "Price in cents (1-99)" },
        amount: { type: "number", description: "Dollar amount to trade" },
        strategy: { type: "string", description: "Which strategy this trade follows" },
        reasoning: { type: "string", description: "Brief explanation of why this trade is being made" },
      },
      required: ["marketId", "marketQuestion", "side", "action", "price", "amount", "reasoning"],
      additionalProperties: false,
    },
  },
};

const FETCH_MARKETS_TOOL = {
  type: "function",
  function: {
    name: "fetch_live_markets",
    description: "Fetch current live prediction markets from Polymarket with real prices and volumes. Use this to get fresh market data before making trading decisions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of markets to fetch (default 10)" },
      },
      additionalProperties: false,
    },
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, strategies, model, temperature, systemPrompt, tradingMode } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Build strategy context
    let strategyBlock = "";
    if (strategies && strategies.length > 0) {
      strategyBlock = "\n\n## Active Trading Strategies\nYou MUST follow these strategy instructions when analyzing markets and suggesting trades:\n\n";
      for (const s of strategies) {
        strategyBlock += `### ${s.name}\n${s.instructions}\n\n`;
      }
      strategyBlock += "When suggesting or executing trades, always reference which strategy you are applying and why.\n";
    }

    const mode = tradingMode || "paper";
    const modeNote = mode === "paper"
      ? "\n\n⚠️ TRADING MODE: PAPER. All trades are simulated. No real money is at risk."
      : "\n\n🔴 TRADING MODE: LIVE. Trades will be executed with real money on Polymarket.";

    const baseSystemPrompt = systemPrompt || `You are an expert algorithmic trading agent for prediction markets (Polymarket).`;

    const fullSystemPrompt = baseSystemPrompt + strategyBlock + modeNote + `

You have access to tools:
1. **fetch_live_markets** - Call this FIRST to get current market data before making any trading decisions.
2. **execute_trade** - Use this to place trades. Always explain your reasoning.

When the user asks you to trade or go trade:
1. First fetch live markets to see current prices
2. Analyze the markets using your active strategies
3. Identify the best opportunities
4. Execute trades with clear reasoning
5. Report back what you did

Always be transparent about your reasoning and risk assessment. Format responses with markdown.`;

    const modelMap: Record<string, string> = {
      "gemini-flash": "google/gemini-3-flash-preview",
      "gemini-pro": "google/gemini-2.5-pro",
      "gpt5": "openai/gpt-5",
      "gpt5-mini": "openai/gpt-5-mini",
    };
    const resolvedModel = modelMap[model] || "google/gemini-3-flash-preview";

    // Initial AI call with tools
    let aiMessages = [
      { role: "system", content: fullSystemPrompt },
      ...messages,
    ];

    let maxIterations = 5;
    let finalStream = null;

    while (maxIterations > 0) {
      maxIterations--;

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: aiMessages,
          tools: [TRADE_TOOL, FETCH_MARKETS_TOOL],
          temperature: temperature ?? 0.3,
          stream: false, // non-streaming for tool calls
        }),
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 429) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded. Please wait and try again." }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (status === 402) {
          return new Response(JSON.stringify({ error: "Usage credits depleted. Please add credits." }), {
            status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const t = await response.text();
        console.error("AI error:", status, t);
        return new Response(JSON.stringify({ error: "AI service error" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await response.json();
      const choice = result.choices?.[0];

      if (!choice) {
        return new Response(JSON.stringify({ error: "No response from AI" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // If no tool calls, stream the final response
      if (choice.finish_reason !== "tool_calls" || !choice.message?.tool_calls?.length) {
        // Do a final streaming call without tools
        const streamResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: resolvedModel,
            messages: aiMessages,
            temperature: temperature ?? 0.3,
            stream: true,
          }),
        });

        return new Response(streamResponse.body, {
          headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
        });
      }

      // Process tool calls
      aiMessages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        const fnName = toolCall.function.name;
        let args: any;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        let toolResult = "";

        if (fnName === "fetch_live_markets") {
          try {
            const limit = args.limit || 10;
            const marketsRes = await fetch(
              `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`
            );
            const events = await marketsRes.json();
            const markets = [];
            for (const event of events) {
              if (event.markets) {
                for (const m of event.markets) {
                  let prices = { yes: 50, no: 50 };
                  try {
                    const p = JSON.parse(m.outcomePrices || "[]");
                    if (p.length >= 2) {
                      prices = { yes: Math.round(parseFloat(p[0]) * 100), no: Math.round(parseFloat(p[1]) * 100) };
                    }
                  } catch {}
                  markets.push({
                    id: m.id,
                    question: m.question || event.title,
                    yesPrice: prices.yes,
                    noPrice: prices.no,
                    volume: m.volume || 0,
                    volume24hr: m.volume24hr || 0,
                    liquidity: m.liquidity || 0,
                    endDate: m.endDate || event.endDate,
                  });
                }
              }
            }
            toolResult = JSON.stringify({ markets: markets.slice(0, limit) });
          } catch (e) {
            toolResult = JSON.stringify({ error: "Failed to fetch markets: " + e.message });
          }
        } else if (fnName === "execute_trade") {
          try {
            // Execute via our own execute-trade function logic
            const tradeData = {
              market_id: args.marketId,
              market_question: args.marketQuestion,
              side: args.side,
              action: args.action,
              price: args.price,
              amount: args.amount,
              strategy: args.strategy || null,
              mode: mode,
              status: mode === "paper" ? "filled" : "pending",
              pnl: 0,
              notes: `Agent trade: ${args.reasoning}`,
            };

            const { data: trade, error: insertError } = await supabase
              .from("trades")
              .insert(tradeData)
              .select()
              .single();

            if (insertError) throw insertError;

            toolResult = JSON.stringify({
              success: true,
              trade,
              message: `${mode.toUpperCase()} trade executed: ${args.action.toUpperCase()} ${args.side.toUpperCase()} on "${args.marketQuestion}" @ ${args.price}¢ for $${args.amount}`,
            });
          } catch (e) {
            toolResult = JSON.stringify({ success: false, error: "Trade execution failed: " + e.message });
          }
        } else {
          toolResult = JSON.stringify({ error: "Unknown tool" });
        }

        aiMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }

    // If we exhausted iterations, do final stream
    const streamResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: aiMessages,
        temperature: temperature ?? 0.3,
        stream: true,
      }),
    });

    return new Response(streamResponse.body, {
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
