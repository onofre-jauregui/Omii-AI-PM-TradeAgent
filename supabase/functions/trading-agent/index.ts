import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Always use production Kalshi API for real live market data
const KALSHI_PROD_URL = "https://api.elections.kalshi.com/trade-api/v2";

function getKalshiBaseUrl(): string {
  return KALSHI_PROD_URL;
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
    },
  },
};

// ─── Provider routing ────────────────────────────────────────────────────────

type Provider = "openrouter" | "anthropic" | "openai" | "google";

function getProvider(model: string): Provider {
  if (model.startsWith("claude-")) return "anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1-") ||
    model.startsWith("o3-") ||
    model.startsWith("o4-")
  )
    return "openai";
  // "gemini-*" without slash = direct Google; "google/gemini-*" with slash = OpenRouter
  if (model.startsWith("gemini-") || model.startsWith("models/")) return "google";
  return "openrouter"; // anything with "/" (e.g. "google/gemini-flash-1.5") or unknown
}

// Returns { baseUrl, apiKey, headers } for non-Anthropic providers (OpenAI-compatible)
function getOpenAICompatConfig(
  provider: Provider,
  keys: Record<string, string>
): { baseUrl: string; apiKey: string } | null {
  if (provider === "openai") {
    const key = keys["openai"];
    if (!key) return null;
    return { baseUrl: "https://api.openai.com/v1", apiKey: key };
  }
  if (provider === "google") {
    const key = keys["google"];
    if (!key) return null;
    return { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: key };
  }
  // openrouter
  const key = keys["openrouter"];
  if (!key) return null;
  return { baseUrl: "https://openrouter.ai/api/v1", apiKey: key };
}

// ─── Anthropic format converters ────────────────────────────────────────────

/** Convert OpenAI-style tools to Anthropic input_schema format */
function toAnthropicTools(tools: any[]): any[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/** Convert OpenAI-style messages to Anthropic format. Returns { system, messages } */
function toAnthropicMessages(msgs: any[]): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];

  for (const m of msgs) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") {
      // Anthropic tool_result must be a user message
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      };
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      // Convert tool_calls to Anthropic tool_use content blocks
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input:
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    // Regular user/assistant message
    out.push({ role: m.role, content: m.content });
  }

  return { system, messages: out };
}

/** Convert Anthropic response back to OpenAI format for the loop */
function fromAnthropicResponse(data: any): any {
  const content = data.content || [];
  const textBlocks = content.filter((b: any) => b.type === "text");
  const toolBlocks = content.filter((b: any) => b.type === "tool_use");

  const message: any = {
    role: "assistant",
    content: textBlocks.map((b: any) => b.text).join("") || null,
    tool_calls: toolBlocks.map((b: any) => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    })),
  };

  const finishReason =
    data.stop_reason === "tool_use"
      ? "tool_calls"
      : data.stop_reason === "end_turn"
      ? "stop"
      : data.stop_reason;

  return {
    choices: [
      {
        message,
        finish_reason: finishReason,
      },
    ],
  };
}

/** Non-streaming call to Anthropic */
async function callAnthropicNonStream(
  model: string,
  apiKey: string,
  msgs: any[],
  tools: any[],
  temperature: number
): Promise<any> {
  const { system, messages } = toAnthropicMessages(msgs);
  const body: any = {
    model,
    max_tokens: 8192,
    messages,
    temperature,
  };
  if (system) body.system = system;
  if (tools.length > 0) body.tools = toAnthropicTools(tools);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const status = resp.status;
    const text = await resp.text();
    throw new Error(`Anthropic error ${status}: ${text}`);
  }
  const data = await resp.json();
  return fromAnthropicResponse(data);
}

/** Stream Anthropic response and re-emit as OpenAI SSE for the frontend */
async function streamAnthropicAsSSE(
  model: string,
  apiKey: string,
  msgs: any[],
  temperature: number
): Promise<Response> {
  const { system, messages } = toAnthropicMessages(msgs);
  const body: any = {
    model,
    max_tokens: 8192,
    messages,
    temperature,
    stream: true,
  };
  if (system) body.system = system;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic stream error ${resp.status}: ${text}`);
  }

  // Convert Anthropic SSE → OpenAI SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = resp.body!.getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          try {
            const evt = JSON.parse(json);
            if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              evt.delta.text
            ) {
              const chunk = {
                choices: [{ delta: { content: evt.delta.text } }],
              };
              await writer.write(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } finally {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, strategies, model, temperature, systemPrompt, tradingMode } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Read all saved AI provider keys from DB
    const { data: keyRows } = await supabase
      .from("api_keys")
      .select("provider, encrypted_secret")
      .in("provider", ["openrouter", "openai", "anthropic", "google"]);

    const keys: Record<string, string> = {};
    for (const row of keyRows || []) {
      if (row.encrypted_secret) keys[row.provider] = row.encrypted_secret;
    }
    // Fall back to env vars
    if (!keys["openrouter"]) keys["openrouter"] = Deno.env.get("OPENROUTER_API_KEY") || "";
    if (!keys["openai"]) keys["openai"] = Deno.env.get("OPENAI_API_KEY") || "";
    if (!keys["anthropic"]) keys["anthropic"] = Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!keys["google"]) keys["google"] = Deno.env.get("GOOGLE_AI_API_KEY") || "";

    // Resolve model
    const modelMap: Record<string, string> = {
      "gemini-flash": "google/gemini-flash-1.5",
      "gemini-pro": "google/gemini-pro-1.5",
      "gpt5": "openai/gpt-4o",
      "gpt5-mini": "openai/gpt-4o-mini",
    };
    let resolvedModel = modelMap[model] || (model?.trim() || null);
    if (!resolvedModel) {
      const { data: savedModel } = await supabase
        .from("api_keys")
        .select("key_id")
        .eq("provider", "model_agent")
        .single();
      resolvedModel = savedModel?.key_id || "google/gemini-flash-1.5";
    }

    // Determine provider and verify we have a key for it
    const provider = getProvider(resolvedModel);

    // If the determined provider has no key but OpenRouter does, fall back to OpenRouter
    const effectiveProvider =
      keys[provider] ? provider : keys["openrouter"] ? "openrouter" : provider;

    // For non-Anthropic providers, ensure the model has the right prefix for OpenRouter
    let finalModel = resolvedModel;
    if (effectiveProvider === "openrouter" && provider !== "openrouter") {
      // e.g. "claude-sonnet-4-6" → "anthropic/claude-sonnet-4-6"
      if (provider === "anthropic" && !resolvedModel.includes("/")) {
        finalModel = `anthropic/${resolvedModel}`;
      } else if (provider === "google" && !resolvedModel.includes("/")) {
        finalModel = `google/${resolvedModel}`;
      } else if (provider === "openai" && !resolvedModel.includes("/")) {
        finalModel = `openai/${resolvedModel}`;
      }
    }

    if (!keys[effectiveProvider]) {
      throw new Error(
        "No AI API key configured. Add an OpenRouter, OpenAI, Anthropic, or Google key in Settings."
      );
    }

    // Build strategy context
    let strategyBlock = "";
    if (strategies && strategies.length > 0) {
      strategyBlock =
        "\n\n## Active Trading Strategies\nYou MUST follow these strategy instructions when analyzing markets and suggesting trades.\nALWAYS include the strategyId (e.g. S-001) and strategy name when executing trades so performance is tracked per-strategy.\n\n";
      for (const s of strategies) {
        const sid = s.id || s.name;
        strategyBlock += `### [${sid}] ${s.name}\n${s.instructions}\n\n`;
      }
      strategyBlock +=
        "When executing trades, set strategyId to the strategy's ID (e.g. 'S-001') and strategy to the strategy name.\n";
    }

    const mode = tradingMode || "paper";
    const modeNote =
      mode === "paper"
        ? "\n\n--- TRADING MODE: PAPER. All trades are simulated. No real money is at risk."
        : "\n\n--- TRADING MODE: LIVE. Trades execute on Kalshi with real money. Apply strict risk management.";

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

    const allTools = [TRADE_TOOL, FETCH_MARKETS_TOOL, CANCEL_ORDER_TOOL, CHECK_PORTFOLIO_TOOL];
    let aiMessages = [{ role: "system", content: fullSystemPrompt }, ...messages];
    let maxIterations = 5;

    while (maxIterations > 0) {
      maxIterations--;

      let result: any;

      if (effectiveProvider === "anthropic") {
        result = await callAnthropicNonStream(
          finalModel,
          keys["anthropic"],
          aiMessages,
          allTools,
          temperature ?? 0.3
        );
      } else {
        const cfg = getOpenAICompatConfig(effectiveProvider, keys);
        if (!cfg) throw new Error(`No API key for provider: ${effectiveProvider}`);

        const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: finalModel,
            messages: aiMessages,
            tools: allTools,
            temperature: temperature ?? 0.3,
            stream: false,
          }),
        });

        if (!resp.ok) {
          const status = resp.status;
          if (status === 429) {
            return new Response(
              JSON.stringify({ error: "Rate limit exceeded. Please wait and try again." }),
              { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          if (status === 402) {
            return new Response(
              JSON.stringify({ error: "Usage credits depleted. Please add credits." }),
              { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          const t = await resp.text();
          console.error("AI error:", status, t);
          let errMsg = `AI provider error (HTTP ${status})`;
          try {
            const parsed = JSON.parse(t);
            errMsg = parsed?.error?.message || parsed?.message || parsed?.error || errMsg;
          } catch { /* ignore */ }
          return new Response(JSON.stringify({ error: errMsg }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        result = await resp.json();
      }

      const choice = result.choices?.[0];
      if (!choice) {
        return new Response(JSON.stringify({ error: "No response from AI" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // No tool calls — stream the final response
      if (
        choice.finish_reason !== "tool_calls" ||
        !choice.message?.tool_calls?.length
      ) {
        if (effectiveProvider === "anthropic") {
          return await streamAnthropicAsSSE(
            finalModel,
            keys["anthropic"],
            aiMessages,
            temperature ?? 0.3
          );
        }

        // OpenAI-compatible streaming
        const cfg = getOpenAICompatConfig(effectiveProvider, keys)!;
        const streamResp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: finalModel,
            messages: aiMessages,
            temperature: temperature ?? 0.3,
            stream: true,
          }),
        });

        return new Response(streamResp.body, {
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
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Failed to fetch Kalshi markets: " + e.message });
          }
        } else if (fnName === "execute_trade") {
          try {
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

            if (mode === "paper") {
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
          } catch (e: any) {
            toolResult = JSON.stringify({
              success: false,
              error: "Trade execution failed: " + e.message,
            });
          }
        } else if (fnName === "cancel_order") {
          try {
            const { data: trades } = await supabase
              .from("trades")
              .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
                notes: `Cancelled by agent: ${args.reason}`,
              })
              .eq("order_id", args.orderId)
              .select();

            if (mode === "live") {
              const kalshiBase = getKalshiBaseUrl();
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
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Cancel failed: " + e.message });
          }
        } else if (fnName === "check_portfolio") {
          try {
            const { data: recentTrades } = await supabase
              .from("trades")
              .select("*")
              .order("created_at", { ascending: false })
              .limit(10);

            const { data: openPositions } = await supabase
              .from("trades")
              .select("*")
              .in("status", ["filled", "open", "partial"])
              .eq("action", "buy")
              .order("created_at", { ascending: false });

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
          } catch (e: any) {
            toolResult = JSON.stringify({
              error: "Failed to fetch portfolio: " + e.message,
            });
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

    // Exhausted iterations — final stream
    if (effectiveProvider === "anthropic") {
      return await streamAnthropicAsSSE(
        finalModel,
        keys["anthropic"],
        aiMessages,
        temperature ?? 0.3
      );
    }

    const cfg = getOpenAICompatConfig(effectiveProvider, keys)!;
    const streamResponse = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: finalModel,
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
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
