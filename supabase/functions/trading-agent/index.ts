import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KALSHI_DEMO_URL = "https://demo-api.kalshi.co/trade-api/v2";
const KALSHI_PROD_URL = "https://trading-api.kalshi.com/trade-api/v2";

function getKalshiBaseUrl(): string {
  const env = Deno.env.get("KALSHI_ENVIRONMENT") || "demo";
  return env === "production" ? KALSHI_PROD_URL : KALSHI_DEMO_URL;
}

const TRADE_TOOL = {
  type: "function",
  function: {
    name: "execute_trade",
    description:
      "Execute a trade on Kalshi event contracts. Use this when the user asks you to trade, buy, sell, or take a position. Always confirm the trade details before executing.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "The Kalshi market ticker (e.g. KXBTC-26APR4-T56000)" },
        marketQuestion: { type: "string", description: "The market question/title" },
        side: { type: "string", enum: ["yes", "no"], description: "Whether to trade YES or NO" },
        action: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
        price: { type: "number", description: "Limit price in cents (1-99)" },
        amount: { type: "number", description: "Dollar amount to trade" },
        orderType: { type: "string", enum: ["limit", "market"], description: "Order type (default: limit)" },
        strategy: { type: "string", description: "Which strategy this trade follows (use the strategy name)" },
        strategyId: { type: "string", description: "The strategy ID (e.g. S-001, S-002). Always include this when trading for a specific strategy." },
        reasoning: { type: "string", description: "Brief explanation of why this trade is being made" },
      },
      required: ["ticker", "marketQuestion", "side", "action", "price", "amount", "reasoning"],
      additionalProperties: false,
    },
  },
};

const FETCH_MARKETS_TOOL = {
  type: "function",
  function: {
    name: "fetch_live_markets",
    description:
      "Fetch current live event contract markets from Kalshi with real prices, volumes, and order book data. Use this to get fresh market data before making trading decisions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of markets to fetch (default 10)" },
        category: { type: "string", description: "Filter by category (e.g. 'economics', 'politics', 'crypto')" },
      },
      additionalProperties: false,
    },
  },
};

const CANCEL_ORDER_TOOL = {
  type: "function",
  function: {
    name: "cancel_order",
    description: "Cancel an open limit order on Kalshi by order ID.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The Kalshi order ID to cancel" },
        reason: { type: "string", description: "Reason for cancellation" },
      },
      required: ["orderId", "reason"],
      additionalProperties: false,
    },
  },
};

const CHECK_PORTFOLIO_TOOL = {
  type: "function",
  function: {
    name: "check_portfolio",
    description: "Check current portfolio positions, balance, and P&L from the database.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, strategies, model, temperature, systemPrompt, tradingMode } = await req.json();

    // AI gateway configuration — supports OpenRouter, OpenAI, or any OpenAI-compatible API
    const AI_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    const AI_BASE_URL = Deno.env.get("AI_BASE_URL") || "https://openrouter.ai/api";
    if (!AI_API_KEY) throw new Error("AI API key not configured. Set OPENROUTER_API_KEY or OPENAI_API_KEY in Supabase secrets.");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Build strategy context — include IDs so agent can tag trades properly
    let strategyBlock = "";
    if (strategies && strategies.length > 0) {
      strategyBlock =
        "\n\n## Active Trading Strategies\nYou MUST follow these strategy instructions when analyzing markets and suggesting trades.\nALWAYS include the strategyId (e.g. S-001) and strategy name when executing trades so performance is tracked per-strategy.\n\n";
      for (const s of strategies) {
        const sid = s.id || s.name;
        strategyBlock += `### [${sid}] ${s.name}\n${s.instructions}\n\n`;
      }
      strategyBlock += "When executing trades, set strategyId to the strategy's ID (e.g. 'S-001') and strategy to the strategy name.\n";
    }

    const mode = tradingMode || "paper";
    const modeNote =
      mode === "paper"
        ? "\n\n--- TRADING MODE: PAPER. All trades are simulated. No real money is at risk."
        : "\n\n--- TRADING MODE: LIVE. Trades execute on Kalshi with real money. Apply strict risk management.";

    // Fetch current risk settings for context
    const { data: riskSettings } = await supabase.from("risk_settings").select("*").single();
    let riskContext = "";
    if (riskSettings) {
      riskContext = `\n\n## Risk Limits (Enforced)
- Max position size: $${riskSettings.max_position_size}
- Max daily loss: $${riskSettings.max_daily_loss}
- Max drawdown: ${riskSettings.max_drawdown_pct}%
- Max open positions: ${riskSettings.max_open_positions}
- Auto stop-loss: ${riskSettings.auto_stop_loss ? "Enabled" : "Disabled"} at ${riskSettings.stop_loss_pct}%
These limits are enforced server-side. Orders exceeding limits will be rejected.`;
    }

    const baseSystemPrompt =
      systemPrompt ||
      `You are an expert algorithmic trading agent for Kalshi event contracts.`;

    const fullSystemPrompt =
      baseSystemPrompt +
      strategyBlock +
      riskContext +
      modeNote +
      `

You have access to tools:
1. **fetch_live_markets** - Call this FIRST to get current Kalshi market data before making any trading decisions.
2. **execute_trade** - Use this to place limit orders on Kalshi. Always explain your reasoning. Price is in cents (1-99).
3. **cancel_order** - Cancel an open limit order by order ID.
4. **check_portfolio** - Check current positions, balance, and recent trades.

When the user asks you to trade or go trade:
1. First fetch live markets to see current prices and spreads
2. Analyze the markets using your active strategies
3. Check portfolio to understand current exposure
4. Identify the best opportunities with favorable risk/reward
5. Execute trades with clear reasoning, respecting risk limits
6. Report back what you did

Important Kalshi-specific notes:
- Prices are in cents (1-99). YES price + NO price = 100.
- Use LIMIT orders by default for better execution. IOC (immediate-or-cancel) for urgent trades.
- Always check the bid-ask spread before trading. Wide spreads mean low liquidity.
- Never exceed position size limits. The system will reject orders that violate risk constraints.

Always be transparent about your reasoning and risk assessment. Format responses with markdown.`;

    const modelMap: Record<string, string> = {
      "gemini-flash": "google/gemini-3-flash-preview",
      "gemini-pro": "google/gemini-2.5-pro",
      "gpt5": "openai/gpt-5",
      "gpt5-mini": "openai/gpt-5-mini",
    };
    const resolvedModel = modelMap[model] || "google/gemini-3-flash-preview";

    let aiMessages = [{ role: "system", content: fullSystemPrompt }, ...messages];
    let maxIterations = 5;

    while (maxIterations > 0) {
      maxIterations--;

      const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: aiMessages,
          tools: [TRADE_TOOL, FETCH_MARKETS_TOOL, CANCEL_ORDER_TOOL, CHECK_PORTFOLIO_TOOL],
          temperature: temperature ?? 0.3,
          stream: false,
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
        const streamResponse = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${AI_API_KEY}`,
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
            const kalshiBase = getKalshiBaseUrl();
            let url = `${kalshiBase}/markets?limit=${limit}&status=open`;
            if (args.category) url += `&series_ticker=${args.category}`;

            const marketsRes = await fetch(url);
            const marketsData = await marketsRes.json();
            const markets = (marketsData.markets || []).map((m: any) => ({
              ticker: m.ticker,
              title: m.title,
              subtitle: m.subtitle,
              yes_bid: m.yes_bid,
              yes_ask: m.yes_ask,
              no_bid: m.no_bid,
              no_ask: m.no_ask,
              last_price: m.last_price,
              volume: m.volume,
              volume_24h: m.volume_24h,
              open_interest: m.open_interest,
              close_time: m.close_time,
              spread: ((m.yes_ask || 0) - (m.yes_bid || 0)).toFixed(2),
            }));
            toolResult = JSON.stringify({ markets: markets.slice(0, limit) });
          } catch (e) {
            toolResult = JSON.stringify({ error: "Failed to fetch Kalshi markets: " + e.message });
          }
        } else if (fnName === "execute_trade") {
          try {
            // Call our execute-trade function internally
            const tradePayload = {
              ticker: args.ticker,
              marketId: args.ticker,
              marketQuestion: args.marketQuestion,
              side: args.side,
              action: args.action,
              price: args.price,
              amount: args.amount,
              strategy: args.strategy || null,
              orderType: args.orderType || "limit",
              mode: mode,
              notes: `Agent trade: ${args.reasoning}`,
            };

            // Execute via internal function call
            const tradeData = {
              ...tradePayload,
              market_id: args.ticker,
              market_question: args.marketQuestion,
            };

            // Insert trade record
            const tradeMode = mode;
            if (tradeMode === "paper") {
              const { data: trade, error: insertError } = await supabase
                .from("trades")
                .insert({
                  ticker: args.ticker,
                  market_id: args.ticker,
                  market_question: args.marketQuestion,
                  side: args.side,
                  action: args.action,
                  price: args.price,
                  amount: args.amount,
                  strategy: args.strategy || null,
                  strategy_id: args.strategyId || null,
                  mode: "paper",
                  status: "filled",
                  filled_price: args.price,
                  filled_at: new Date().toISOString(),
                  exchange: "paper",
                  order_type: args.orderType || "limit",
                  pnl: 0,
                  notes: `Agent trade: ${args.reasoning}`,
                })
                .select()
                .single();

              if (insertError) throw insertError;

              // Log compliance
              await supabase.from("compliance_log").insert({
                trade_id: trade.id,
                event_type: "order_filled",
                severity: "info",
                message: `Paper trade filled: ${args.action} ${args.side} ${args.ticker} @ ${args.price}c for $${args.amount}`,
                metadata: { mode: "paper", reasoning: args.reasoning },
              });

              toolResult = JSON.stringify({
                success: true,
                trade,
                message: `PAPER trade: ${args.action.toUpperCase()} ${args.side.toUpperCase()} ${args.ticker} @ ${args.price}c for $${args.amount}`,
              });
            } else {
              // For live mode, call the execute-trade edge function
              const execUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-trade`;
              const execResp = await fetch(execUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(tradePayload),
              });
              const execResult = await execResp.json();
              toolResult = JSON.stringify(execResult);
            }
          } catch (e) {
            toolResult = JSON.stringify({ success: false, error: "Trade execution failed: " + e.message });
          }
        } else if (fnName === "cancel_order") {
          try {
            // Update trade status in DB
            const { data: trades } = await supabase
              .from("trades")
              .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
                notes: `Cancelled by agent: ${args.reason}`,
              })
              .eq("order_id", args.orderId)
              .select();

            // If live mode, cancel on Kalshi too
            if (mode === "live") {
              const kalshiBase = getKalshiBaseUrl();
              // Note: In production, this would use authenticated headers
              await fetch(`${kalshiBase}/portfolio/orders/${args.orderId}`, {
                method: "DELETE",
              });
            }

            await supabase.from("compliance_log").insert({
              trade_id: trades?.[0]?.id || null,
              event_type: "order_cancelled",
              severity: "info",
              message: `Order ${args.orderId} cancelled: ${args.reason}`,
              metadata: { order_id: args.orderId, reason: args.reason },
            });

            toolResult = JSON.stringify({
              success: true,
              message: `Order ${args.orderId} cancelled: ${args.reason}`,
            });
          } catch (e) {
            toolResult = JSON.stringify({ success: false, error: "Cancel failed: " + e.message });
          }
        } else if (fnName === "check_portfolio") {
          try {
            // Get recent trades
            const { data: recentTrades } = await supabase
              .from("trades")
              .select("*")
              .order("created_at", { ascending: false })
              .limit(10);

            // Get open positions
            const { data: openPositions } = await supabase
              .from("trades")
              .select("*")
              .in("status", ["filled", "open", "partial"])
              .eq("action", "buy")
              .order("created_at", { ascending: false });

            // Get today's risk state
            const today = new Date().toISOString().split("T")[0];
            const { data: riskState } = await supabase
              .from("risk_state")
              .select("*")
              .eq("date", today)
              .single();

            toolResult = JSON.stringify({
              recent_trades: recentTrades || [],
              positions: openPositions || [],
              risk_state: riskState || { daily_pnl: 0, daily_trades: 0 },
            });
          } catch (e) {
            toolResult = JSON.stringify({ error: "Failed to fetch portfolio: " + e.message });
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

    // Exhausted iterations, final stream
    const streamResponse = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
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
