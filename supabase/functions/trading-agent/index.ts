import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { KALSHI_BASE_URL } from "../_shared/kalshi-auth.ts";

// ─── Tool Definitions ───────────────────────────────────────────────────────

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
        expectedOutcome: { type: "string", description: "What you expect to happen and why (stored for later reflection)" },
        confidenceLevel: { type: "number", description: "Your confidence in this trade from 0.0 to 1.0" },
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
      "Fetch current live event contract markets from Kalshi with real prices, volumes, and order book data. Use this to get fresh market data before making trading decisions. Use 'keyword' to search by any topic — team names, player names, event names, country names, etc.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of markets to fetch (default 20)" },
        category: { type: "string", description: "Filter by Kalshi series ticker (e.g. 'KXFED', 'KXMLB', 'KXNBA')" },
        keyword: { type: "string", description: "Free-text search across all Kalshi markets by title/topic. Examples: 'Mexico', 'soccer', 'Trump', 'Bitcoin', 'Lakers'. Use this when the user asks about a specific team, event, or topic." },
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

// ─── Memory Tools ───────────────────────────────────────────────────────────

const REFLECT_ON_TRADES_TOOL = {
  type: "function",
  function: {
    name: "reflect_on_trades",
    description:
      "Analyze recent completed trades to learn from outcomes. Reviews trades that haven't been reflected on yet. Call this periodically or when the user asks you to learn from past trades. This helps you improve over time by identifying what worked, what didn't, and why.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent trades to reflect on (default 20)" },
        strategyId: { type: "string", description: "Only reflect on trades from a specific strategy" },
      },
    },
  },
};

const RECALL_LESSONS_TOOL = {
  type: "function",
  function: {
    name: "recall_lessons",
    description:
      "Search your memory for relevant lessons, patterns, and insights from past trading. Call this BEFORE making trading decisions to leverage what you've learned. You can search by tags, strategy, or memory type.",
    parameters: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (e.g. ['crypto', 'momentum', 'low_liquidity'])",
        },
        strategyId: { type: "string", description: "Filter by strategy ID" },
        memoryType: {
          type: "string",
          enum: ["lesson", "pattern", "mistake", "success", "market_note", "strategy_insight"],
          description: "Filter by type of memory",
        },
        searchText: { type: "string", description: "Free-text search across titles and content" },
        limit: { type: "number", description: "Max memories to return (default 10)" },
      },
    },
  },
};

const SAVE_INSIGHT_TOOL = {
  type: "function",
  function: {
    name: "save_insight",
    description:
      "Save a new lesson, pattern, or insight to your persistent memory. Use this when you discover something important about markets, strategies, or trading patterns. These memories persist across sessions and help you make better decisions over time.",
    parameters: {
      type: "object",
      properties: {
        memoryType: {
          type: "string",
          enum: ["lesson", "pattern", "mistake", "success", "market_note", "strategy_insight"],
          description: "Type of memory: lesson (general learning), pattern (recurring market behavior), mistake (what went wrong), success (what went right), market_note (market observation), strategy_insight (strategy-specific learning)",
        },
        title: { type: "string", description: "Short descriptive title for this memory" },
        content: { type: "string", description: "Detailed description of the insight, including context, reasoning, and actionable takeaway" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (e.g. ['crypto', 'spread', 'timing'])",
        },
        strategyId: { type: "string", description: "Strategy this applies to (omit if it applies broadly)" },
        confidence: { type: "number", description: "How confident you are in this insight (0.0-1.0, default 0.5)" },
        relatedTradeIds: {
          type: "array",
          items: { type: "string" },
          description: "Trade IDs that informed this insight",
        },
      },
      required: ["memoryType", "title", "content"],
    },
  },
};

const UPDATE_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "update_memory",
    description:
      "Update an existing memory — increase confidence when confirmed, decrease when contradicted, or deactivate if no longer relevant.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "The memory ID to update" },
        action: {
          type: "string",
          enum: ["confirm", "contradict", "deactivate", "update_content"],
          description: "What to do: confirm (boost confidence), contradict (lower confidence), deactivate (mark obsolete), update_content (edit the content)",
        },
        newContent: { type: "string", description: "New content (only for update_content action)" },
        reason: { type: "string", description: "Why you're updating this memory" },
      },
      required: ["memoryId", "action"],
    },
  },
};

// ─── Basket Execution Tool ──────────────────────────────────────────────────

const EXECUTE_BASKET_TOOL = {
  type: "function",
  function: {
    name: "execute_basket",
    description:
      "Execute a multi-leg basket trade for surface arbitrage opportunities. Use this when scan_surface returns a monotonicity_violation or bracket_sum_violation — these require two coordinated legs to be profitable. The basket engine executes legs in order, re-checks edge after each fill, and automatically flattens any filled legs if the basket can't complete (preventing naked directional exposure). Never use execute_trade for arb — use this instead.",
    parameters: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The surface_alerts.id that triggered this basket" },
        legs: {
          type: "array",
          description: "Ordered array of legs. Most fragile / thinnest market first.",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              market_question: { type: "string" },
              side: { type: "string", enum: ["yes", "no"] },
              action: { type: "string", enum: ["buy", "sell"] },
              price: { type: "number", description: "Limit price in cents (1-99)" },
              amount: { type: "number", description: "Dollar amount" },
              order_type: { type: "string", enum: ["limit", "market"] },
            },
            required: ["ticker", "side", "action", "price", "amount"],
          },
        },
        expected_edge_cents: { type: "number", description: "Total expected edge in cents if all legs fill" },
        reasoning: { type: "string", description: "Why this basket is being executed" },
      },
      required: ["legs", "expected_edge_cents", "reasoning"],
    },
  },
};

// ─── Signal + Surface Tools ─────────────────────────────────────────────────

const FETCH_SIGNALS_TOOL = {
  type: "function",
  function: {
    name: "fetch_signals",
    description:
      "Run the systematic signal generator to score and rank all live Kalshi markets before making trading decisions. Returns markets scored across liquidity, edge, time-value, and volume dimensions with direction recommendations (buy_yes / buy_no / skip). Call this BEFORE fetch_live_markets when you want a pre-ranked shortlist of opportunities rather than raw market data.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max signals to return (default 20)" },
        category: { type: "string", description: "Filter to a specific series (e.g. 'KXBTC', 'KXINX', 'KXFED')" },
      },
    },
  },
};

const SCAN_SURFACE_TOOL = {
  type: "function",
  function: {
    name: "scan_surface",
    description:
      "Scan for cross-market inconsistencies and arbitrage opportunities across all live Kalshi event series. Detects: (1) monotonicity violations — related threshold markets where a lower threshold is priced cheaper than a higher one (riskless arb); (2) bracket sum violations — MECE discrete-outcome markets where YES prices don't sum to ~100; (3) spread anomalies — markets with abnormally wide spreads vs. peers. Returns ranked alerts with specific trade actions. Call this when looking for structural edge beyond individual market analysis.",
    parameters: {
      type: "object",
      properties: {
        min_edge_cents: { type: "number", description: "Minimum expected edge in cents to include an alert (default 3)" },
      },
    },
  },
};

const SEARCH_WEB_TOOL = {
  type: "function",
  function: {
    name: "search_web",
    description:
      "Search the web for current events, news, or data relevant to a Kalshi market. Use for: upcoming FOMC decisions, weather outlooks, economic reports, sports schedules, political events. Returns up to 5 recent results with title, URL, and content snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        focus: {
          type: "string",
          enum: ["news", "finance", "weather", "sports"],
          description: "Optional search focus to improve result relevance",
        },
      },
      required: ["query"],
    },
  },
};

const CREATE_STRATEGY_TOOL = {
  type: "function",
  function: {
    name: "create_strategy",
    description:
      "Create a new trading strategy from a user description. Saves it as inactive — the user must activate it in the Strategies tab. Use when the user asks to create, define, or set up a strategy.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short display name for the strategy" },
        instructions: {
          type: "string",
          description: "Natural language rules for how the agent should qualify and trade signals for this strategy",
        },
        market_types: {
          type: "array",
          items: { type: "string" },
          description: "Market series this strategy targets, e.g. [\"weather\", \"fomc\", \"crypto\"]",
        },
      },
      required: ["name", "instructions"],
    },
  },
};

const TRIGGER_STRATEGY_RUN_TOOL = {
  type: "function",
  function: {
    name: "trigger_strategy_run",
    description:
      "Manually trigger a strategy run right now without waiting for the 2-minute cron cycle. Use when the user asks the agent to 'go trade now', 'run a strategy', or 'execute S-002'. Returns the compliance log message from the run.",
    parameters: {
      type: "object",
      properties: {
        strategy_id: {
          type: "string",
          description: "Strategy ID to run, e.g. 'S-002' or 'S-005'",
        },
      },
      required: ["strategy_id"],
    },
  },
};

// ─── Provider routing ───────────────────────────────────────────────────────

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
  if (model.startsWith("gemini-") || model.startsWith("models/")) return "google";
  return "openrouter";
}

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
  const key = keys["openrouter"];
  if (!key) return null;
  return { baseUrl: "https://openrouter.ai/api/v1", apiKey: key };
}

// ─── Anthropic format converters ────────────────────────────────────────────

function toAnthropicTools(tools: any[]): any[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function toAnthropicMessages(msgs: any[]): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") {
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
    out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}

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
  return { choices: [{ message, finish_reason: finishReason }] };
}

async function callAnthropicNonStream(
  model: string,
  apiKey: string,
  msgs: any[],
  tools: any[],
  temperature: number
): Promise<any> {
  const { system, messages } = toAnthropicMessages(msgs);
  const body: any = { model, max_tokens: 8192, messages, temperature };
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
    const text = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${text}`);
  }
  return fromAnthropicResponse(await resp.json());
}

async function streamAnthropicAsSSE(
  model: string,
  apiKey: string,
  msgs: any[],
  temperature: number
): Promise<Response> {
  const { system, messages } = toAnthropicMessages(msgs);
  const body: any = { model, max_tokens: 8192, messages, temperature, stream: true };
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
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: evt.delta.text } }] })}\n\n`));
            }
          } catch {}
        }
      }
    } finally {
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
    }
  })();
  return new Response(readable, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
}

// ─── Main handler ───────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight("extended");

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { messages, strategies, model, temperature, systemPrompt, tradingMode } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "messages array is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: "Server configuration error: missing Supabase credentials" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Resolve the calling user from their session JWT so agent trades are attributed correctly.
    // This mirrors the resolveTenant pattern in execute-trade/tenant.ts.
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
    if (authHeader?.toLowerCase().startsWith("bearer ")) {
      const jwt = authHeader.slice(7).trim();
      if (jwt && jwt !== supabaseKey) {
        try {
          const { data } = await supabase.auth.getUser(jwt);
          if (data?.user?.id) userId = data.user.id;
        } catch { /* non-fatal — fall back to null */ }
      }
    }

    // ── Load API keys ──
    const { data: keyRows } = await supabase
      .from("api_keys")
      .select("provider, encrypted_secret")
      .in("provider", ["openrouter", "openai", "anthropic", "google"]);

    const keys: Record<string, string> = {};
    for (const row of keyRows || []) {
      if (row.encrypted_secret) keys[row.provider] = row.encrypted_secret;
    }
    if (!keys["openrouter"]) keys["openrouter"] = Deno.env.get("OPENROUTER_API_KEY") || "";
    if (!keys["openai"]) keys["openai"] = Deno.env.get("OPENAI_API_KEY") || "";
    if (!keys["anthropic"]) keys["anthropic"] = Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!keys["google"]) keys["google"] = Deno.env.get("GOOGLE_AI_API_KEY") || "";

    // ── Resolve model ──
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
        .maybeSingle();
      resolvedModel = savedModel?.key_id || "openai/gpt-4o-mini";
    }

    const provider = getProvider(resolvedModel);
    const effectiveProvider =
      keys[provider] ? provider : keys["openrouter"] ? "openrouter" : provider;

    let finalModel = resolvedModel;
    if (effectiveProvider === "openrouter" && provider !== "openrouter") {
      if (provider === "anthropic" && !resolvedModel.includes("/")) finalModel = `anthropic/${resolvedModel}`;
      else if (provider === "google" && !resolvedModel.includes("/")) finalModel = `google/${resolvedModel}`;
      else if (provider === "openai" && !resolvedModel.includes("/")) finalModel = `openai/${resolvedModel}`;
    }

    if (!keys[effectiveProvider]) {
      throw new Error("No AI API key configured. Add an OpenRouter, OpenAI, Anthropic, or Google key in Settings.");
    }

    // ── Build strategy context ──
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

    const { data: riskSettings } = await supabase.from("risk_settings").select("*").maybeSingle();
    let riskContext = "";
    if (riskSettings) {
      riskContext = `\n\n## Risk Limits (Enforced)\n- Max position size: $${riskSettings.max_position_size}\n- Max daily loss: $${riskSettings.max_daily_loss}\n- Max drawdown: ${riskSettings.max_drawdown_pct}%\n- Max open positions: ${riskSettings.max_open_positions}\n- Auto stop-loss: ${riskSettings.auto_stop_loss ? "Enabled" : "Disabled"} at ${riskSettings.stop_loss_pct}%\nThese limits are enforced server-side. Orders exceeding limits will be rejected.`;
    }

    // ── Load persistent memory (compact summaries with token budget) ──
    const MEMORY_TOKEN_BUDGET = 1500; // max ~1500 tokens for memory block
    const { data: topMemories } = await supabase
      .from("agent_memory")
      .select("id, memory_type, title, content, summary, tags, confidence, strategy_id, child_count, created_at")
      .eq("is_active", true)
      .is("merged_into", null) // merged originals stay in DB but are excluded here; use recall_lessons to retrieve them
      .order("confidence", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(30);

    let memoryBlock = "";
    if (topMemories && topMemories.length > 0) {
      memoryBlock = "\n\n## Your Trading Memory (Persistent Lessons)\nThese are insights you've learned from past trading sessions. Use them to make better decisions. If new evidence contradicts a lesson, use the update_memory tool to adjust it. Use `recall_lessons` to retrieve full details on any memory.\n\n";
      let tokenCount = 0;
      for (const mem of topMemories) {
        const tags = (mem.tags || []).length > 0 ? ` [${mem.tags.join(", ")}]` : "";
        const conf = `(${(mem.confidence * 100).toFixed(0)}%)`;
        const merged = (mem.child_count || 0) > 1 ? ` (merged from ${mem.child_count} insights)` : "";
        // Use summary if available, fall back to content
        const displayText = mem.summary || mem.content;
        const line = `- **[${mem.memory_type.toUpperCase()}]** ${mem.title} ${conf}${merged}${tags}: ${displayText}\n`;
        const lineTokens = Math.ceil(line.length / 4);
        if (tokenCount + lineTokens > MEMORY_TOKEN_BUDGET) break;
        memoryBlock += line;
        tokenCount += lineTokens;
      }
    }

    // ── Load recent trade performance summary ──
    // P&L only exists on settled trades; filled trades always have pnl=0
    const MAY_START = "2026-05-01T00:00:00.000Z";
    const { data: recentFilledTrades } = await supabase
      .from("trades")
      .select("ticker, side, action, price, amount, pnl, strategy, settled_at")
      .eq("status", "settled")
      .gte("settled_at", MAY_START)
      .order("settled_at", { ascending: false })
      .limit(20);

    let performanceBlock = "";
    if (recentFilledTrades && recentFilledTrades.length > 0) {
      const totalPnl = recentFilledTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
      const wins = recentFilledTrades.filter((t) => (Number(t.pnl) || 0) > 0).length;
      const losses = recentFilledTrades.filter((t) => (Number(t.pnl) || 0) < 0).length;
      const neutral = recentFilledTrades.length - wins - losses;
      performanceBlock = `\n\n## Recent Performance (last ${recentFilledTrades.length} trades)\n- Total P&L: $${totalPnl.toFixed(2)}\n- Wins: ${wins} | Losses: ${losses} | Neutral: ${neutral}\n- Win rate: ${recentFilledTrades.length > 0 ? ((wins / recentFilledTrades.length) * 100).toFixed(0) : 0}%\nUse reflect_on_trades to analyze patterns in these results.\n`;
    }

    // ── Check for unreflected settled trades ──
    const { data: unreflectedTrades } = await supabase
      .from("trades")
      .select("id")
      .eq("status", "settled")
      .not("id", "in", `(SELECT trade_id FROM trade_reflections)`)
      .limit(1);

    // This query might fail if the subquery isn't supported; handle gracefully
    const hasUnreflected = (unreflectedTrades?.length || 0) > 0;
    const reflectionHint = hasUnreflected
      ? "\n\n> **Note:** You have trades that haven't been reflected on yet. Consider calling `reflect_on_trades` to learn from recent outcomes.\n"
      : "";

    const baseSystemPrompt =
      systemPrompt ||
      `You are an expert algorithmic trading agent for Kalshi event contracts.`;

    const fullSystemPrompt =
      baseSystemPrompt +
      strategyBlock +
      riskContext +
      memoryBlock +
      performanceBlock +
      reflectionHint +
      modeNote +
      `

## Kalshi Market Catalogue

IMPORTANT: Kalshi's search keyword endpoint is broken — it returns irrelevant sportsbook parlay markets for any search term. DO NOT use keyword in fetch_live_markets. Always use category with the series ticker instead.

Known series and their category values for fetch_live_markets:
- Weather New York City: category=KXHIGHNY
- Weather Los Angeles: category=KXHIGHLAX
- Weather Miami: category=KXHIGHMIA
- Weather Chicago: category=KXHIGHCHI
- Weather Austin: category=KXHIGHAUS
- Weather Phoenix: category=KXHIGHPHX
- Weather Seattle: category=KXHIGHSEA
- Weather Dallas: category=KXHIGHDAL
- Bitcoin: category=KXBTC
- Ethereum: category=KXETH — HARD REJECTED (consistent losses)
- S&P 500 / Nasdaq: category=KXINX
- Fed rate decisions: category=KXFED — HARD REJECTED (zero liquidity)
- GDP / Payrolls / CPI: category=KXGDP or KXPAYROLLS or KXCPI
- NHL / NBA / MLB / NFL / Soccer: category=KXNHL or KXNBA or KXMLB or KXNFL or KXMLS
- FIFA World Cup: category=KXWCGAME
- US Politics / Elections: category=KXPRES or KXSENATE

Weather markets settle at end of the local calendar day. If a user asks about weather "today" in the evening, today's market may already be closed — show them tomorrow's open markets and note today's has closed.

Critical rule: If the user provides a market ticker — fetch that market and trust what comes back. Never invent an explanation without evidence from the fetched data.

## Natural Language Market Search — REQUIRED BEHAVIOR

When the user describes a market topic WITHOUT a ticker:
1. Map their description to the closest series ticker from the catalogue above
2. Call fetch_live_markets with category=<series_ticker> — NEVER use keyword (it is broken and returns wrong results)
3. Present the top 1–3 open markets in a card-style format:
   > **Found:** [Market Title]
   > Ticker: \`KXHIGHNY-26MAY22-B69.5\` | YES: 42c | NO: 58c | Vol: $14K | Closes: May 22
4. Ask: "Is this the market you're looking for? If yes — YES or NO?"
5. Wait for confirmation before executing

If no series ticker maps to their request, call fetch_live_markets with NO parameters (returns broad market list) and scan visually. Never tell the user "I couldn't find it" without first trying at least one category fetch.

## Tool Workflow

**User-initiated trades (no ticker provided):** map topic → fetch_live_markets(category=series) → present 1–3 matches → confirm direction → execute_trade
**User-initiated trades (ticker provided):** execute_trade directly
**Autonomous analysis:** recall_lessons → fetch_signals → scan_surface → check_portfolio → execute → save_insight/reflect_on_trades

- Arb alerts (monotonicity_violation, bracket_sum_violation): **execute_basket** only — never execute_trade for 2-leg arb (naked exposure risk)
- Single-leg signals: **execute_trade** with reasoning + expectedOutcome + confidenceLevel
- composite_score ≥ 0.65 = strong; direction "skip" = pass
- Kalshi prices in cents (1-99); YES+NO=100; use LIMIT orders; wide spread = low liquidity

## Conversation Memory
Save user preferences via save_insight (tag "user_preference"): risk limits, market interests, style, strategy directives. Use memoryType "lesson", "market_note", or "strategy_insight".

Format responses with markdown. Be transparent about reasoning and risk.`;

    // ── All tools ──
    const allTools = [
      FETCH_SIGNALS_TOOL,
      SCAN_SURFACE_TOOL,
      EXECUTE_BASKET_TOOL,
      TRADE_TOOL,
      FETCH_MARKETS_TOOL,
      CANCEL_ORDER_TOOL,
      CHECK_PORTFOLIO_TOOL,
      REFLECT_ON_TRADES_TOOL,
      RECALL_LESSONS_TOOL,
      SAVE_INSIGHT_TOOL,
      UPDATE_MEMORY_TOOL,
      SEARCH_WEB_TOOL,
      CREATE_STRATEGY_TOOL,
      TRIGGER_STRATEGY_RUN_TOOL,
    ];

    let aiMessages = [{ role: "system", content: fullSystemPrompt }, ...messages];
    let maxIterations = 12; // Supports: recall → fetch_signals → scan_surface → portfolio → fetch_markets → trade chains

    while (maxIterations > 0) {
      maxIterations--;

      let result: any;

      if (effectiveProvider === "anthropic") {
        result = await callAnthropicNonStream(finalModel, keys["anthropic"], aiMessages, allTools, temperature ?? 0.3);
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
            return new Response(JSON.stringify({ error: "Rate limit exceeded. Please wait and try again." }), {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          if (status === 402) {
            return new Response(JSON.stringify({ error: "Usage credits depleted. Please add credits." }), {
              status: 402,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          const t = await resp.text();
          console.error("AI error:", status, t);
          let errMsg = `AI provider error (HTTP ${status})`;
          try {
            const parsed = JSON.parse(t);
            errMsg = parsed?.error?.message || parsed?.message || parsed?.error || errMsg;
          } catch {}
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
      if (choice.finish_reason !== "tool_calls" || !choice.message?.tool_calls?.length) {
        if (effectiveProvider === "anthropic") {
          return await streamAnthropicAsSSE(finalModel, keys["anthropic"], aiMessages, temperature ?? 0.3);
        }
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

        // ── fetch_live_markets ──
        if (fnName === "fetch_live_markets") {
          try {
            const limit = args.limit || 10;
            const kalshiBase = KALSHI_BASE_URL;

            // Helper: parse a market into a compact object
            const parseMarket = (m: any) => ({
              ticker: m.ticker,
              title: m.title || m.subtitle,
              yes_bid: m.yes_bid_dollars ?? m.yes_bid,
              yes_ask: m.yes_ask_dollars ?? m.yes_ask,
              no_bid: m.no_bid_dollars ?? m.no_bid,
              no_ask: m.no_ask_dollars ?? m.no_ask,
              last_price: m.last_price_dollars ?? m.last_price,
              volume: m.volume,
              volume_24h: m.volume_24h,
              open_interest: m.open_interest,
              close_time: m.close_time,
              spread: (((m.yes_ask_dollars ?? m.yes_ask) || 0) - ((m.yes_bid_dollars ?? m.yes_bid) || 0)).toFixed(2),
            });

            // Helper: is this a real tradeable market?
            const isLiquid = (m: any): boolean => {
              if ((m.ticker || "").startsWith("KXMVE")) return false;
              const ya = Number(m.yes_ask_dollars ?? m.yes_ask) || 0;
              const yb = Number(m.yes_bid_dollars ?? m.yes_bid) || 0;
              const last = Number(m.last_price_dollars ?? m.last_price) || 0;
              return ya > 0.005 || yb > 0.005 || last > 0.005;
            };

            let allMarkets: any[] = [];

            if (args.keyword) {
              // Free-text keyword search across all Kalshi markets
              const encoded = encodeURIComponent(args.keyword);
              const url = `${kalshiBase}/markets?limit=50&status=open&search=${encoded}`;
              const res = await fetch(url);
              const data = await res.json();
              allMarkets = (data.markets || []).map(parseMarket);
            } else if (args.category) {
              // Series ticker fetch
              const url = `${kalshiBase}/markets?limit=${Math.min(limit * 3, 60)}&status=open&series_ticker=${args.category}`;
              const res = await fetch(url);
              const data = await res.json();
              allMarkets = (data.markets || []).filter(isLiquid).map(parseMarket);
            } else {
              // Parallel fetch from known active Kalshi series across all categories.
              const series = [
                // Economics
                "KXFED", "KXGDP", "KXPAYROLLS", "KXCPI", "KXINX", "KXCHCUTS",
                // Crypto
                "KXBTC", "KXETH",
                // Sports
                "KXNHL", "KXNBA", "KXMLB", "KXNFL", "KXMLS", "KXSOCCER",
                // Politics / News
                "KXPRES", "KXSENATE",
              ];

              const fetches = series.map(s =>
                fetch(`${kalshiBase}/markets?limit=20&status=open&series_ticker=${s}`)
                  .then(r => r.json()).catch(() => ({ markets: [] }))
              );

              const results = await Promise.all(fetches);

              for (const result of results) {
                for (const m of (result.markets || [])) {
                  if (isLiquid(m)) allMarkets.push(parseMarket(m));
                }
              }

              // Deduplicate and sort by volume
              const seen = new Set<string>();
              allMarkets = allMarkets
                .filter(m => { if (seen.has(m.ticker)) return false; seen.add(m.ticker); return true; })
                .sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0));
            }

            const finalMarkets = allMarkets.slice(0, limit);
            if (finalMarkets.length === 0) {
              toolResult = JSON.stringify({ markets: [], note: `No markets found${args.keyword ? ` for "${args.keyword}"` : ""}. Kalshi may not have active markets on this topic right now.` });
            } else {
              toolResult = JSON.stringify({ markets: finalMarkets, total_found: allMarkets.length });
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Failed to fetch Kalshi markets: " + e.message });
          }
        }

        // ── execute_trade ──
        // All modes (paper + live) go through execute-trade for consistent
        // risk checks, reflection creation, and risk state updates.
        else if (fnName === "execute_trade") {
          try {
            const execUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-trade`;
            const execResp = await fetch(execUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ticker: args.ticker,
                marketId: args.ticker,
                marketQuestion: args.marketQuestion,
                side: args.side,
                action: args.action,
                price: args.price,
                amount: args.amount,
                strategy: args.strategy || null,
                strategyId: args.strategyId || null,
                orderType: args.orderType || "limit",
                mode,
                user_id: userId,
                notes: `Agent trade: ${args.reasoning}`,
                expectedOutcome: args.expectedOutcome || null,
                confidenceLevel: args.confidenceLevel || null,
              }),
            });
            const execResult = await execResp.json();
            toolResult = JSON.stringify(execResult);
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Trade execution failed: " + e.message });
          }
        }

        // ── cancel_order ──
        else if (fnName === "cancel_order") {
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
              await fetch(`${KALSHI_BASE_URL}/portfolio/orders/${args.orderId}`, { method: "DELETE" });
            }

            await supabase.from("compliance_log").insert({
              trade_id: trades?.[0]?.id || null,
              event_type: "order_cancelled",
              severity: "info",
              message: `Order ${args.orderId} cancelled: ${args.reason}`,
              metadata: { order_id: args.orderId, reason: args.reason },
            });

            toolResult = JSON.stringify({ success: true, message: `Order ${args.orderId} cancelled: ${args.reason}` });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Cancel failed: " + e.message });
          }
        }

        // ── check_portfolio ──
        else if (fnName === "check_portfolio") {
          try {
            // Settled trades carry real P&L; show most recent settled for accurate stats
            const { data: recentTrades } = await supabase
              .from("trades")
              .select("ticker, side, action, price, amount, pnl, strategy, status, settled_at")
              .eq("status", "settled")
              .gte("settled_at", "2026-05-01T00:00:00.000Z")
              .order("settled_at", { ascending: false })
              .limit(10);

            const { data: openPositions } = await supabase
              .from("trades")
              .select("ticker, market_question, side, action, price, amount, pnl, strategy, status, created_at")
              .in("status", ["filled", "open", "partial"])
              .eq("action", "buy")
              .order("created_at", { ascending: false })
              .limit(20);

            const today = new Date().toISOString().split("T")[0];
            const { data: riskState } = await supabase
              .from("risk_state")
              .select("*")
              .eq("date", today)
              .maybeSingle();

            // Also return memory count so agent knows its memory state
            const { count: memoryCount } = await supabase
              .from("agent_memory")
              .select("*", { count: "exact", head: true })
              .eq("is_active", true);

            toolResult = JSON.stringify({
              recent_trades: recentTrades || [],
              positions: openPositions || [],
              risk_state: riskState || { daily_pnl: 0, daily_trades: 0 },
              memory_stats: { active_memories: memoryCount || 0 },
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Failed to fetch portfolio: " + e.message });
          }
        }

        // ── reflect_on_trades ──
        else if (fnName === "reflect_on_trades") {
          try {
            const limit = args.limit || 20;
            let query = supabase
              .from("trades")
              .select("id, ticker, side, action, price, amount, pnl, strategy, strategy_id, status, settled_at")
              .eq("status", "settled")
              .gte("settled_at", "2026-05-01T00:00:00.000Z")
              .order("settled_at", { ascending: false })
              .limit(limit);

            if (args.strategyId) query = query.eq("strategy_id", args.strategyId);

            const { data: trades } = await query;

            // Load existing reflections for these trades
            const tradeIds = (trades || []).map((t) => t.id);
            const { data: existingReflections } = await supabase
              .from("trade_reflections")
              .select("trade_id, expected_outcome, actual_outcome, analysis, decision_quality")
              .in("trade_id", tradeIds.length > 0 ? tradeIds : ["00000000-0000-0000-0000-000000000000"]);

            const reflectedIds = new Set((existingReflections || []).map((r) => r.trade_id));
            const unreflected = (trades || []).filter((t) => !reflectedIds.has(t.id));

            // Compute stats
            const allPnl = (trades || []).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
            const wins = (trades || []).filter((t) => (Number(t.pnl) || 0) > 0).length;
            const losses = (trades || []).filter((t) => (Number(t.pnl) || 0) < 0).length;

            // Group by strategy
            const byStrategy: Record<string, { trades: number; pnl: number; wins: number; losses: number }> = {};
            for (const t of trades || []) {
              const sid = t.strategy_id || t.strategy || "no_strategy";
              if (!byStrategy[sid]) byStrategy[sid] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
              byStrategy[sid].trades++;
              byStrategy[sid].pnl += Number(t.pnl) || 0;
              if ((Number(t.pnl) || 0) > 0) byStrategy[sid].wins++;
              if ((Number(t.pnl) || 0) < 0) byStrategy[sid].losses++;
            }

            toolResult = JSON.stringify({
              summary: {
                total_trades: (trades || []).length,
                total_pnl: allPnl,
                wins,
                losses,
                win_rate: (trades || []).length > 0 ? (wins / (trades || []).length * 100).toFixed(1) + "%" : "N/A",
                unreflected_count: unreflected.length,
              },
              by_strategy: byStrategy,
              unreflected_trades: unreflected.slice(0, 10),
              existing_reflections: existingReflections || [],
              instruction: "Analyze these trades. For unreflected trades, determine what went right/wrong. Save insights using save_insight. Update existing reflections with your analysis.",
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Reflection failed: " + e.message });
          }
        }

        // ── recall_lessons ──
        else if (fnName === "recall_lessons") {
          try {
            const limit = args.limit || 10;
            let query = supabase
              .from("agent_memory")
              .select("id, memory_type, title, content, tags, confidence, strategy_id, created_at")
              .eq("is_active", true)
              .order("confidence", { ascending: false })
              .order("created_at", { ascending: false })
              .limit(limit);

            if (args.strategyId) query = query.eq("strategy_id", args.strategyId);
            if (args.memoryType) query = query.eq("memory_type", args.memoryType);
            if (args.tags && args.tags.length > 0) query = query.overlaps("tags", args.tags);
            if (args.searchText) query = query.or(`title.ilike.%${args.searchText}%,content.ilike.%${args.searchText}%`);

            const { data: memories } = await query;

            // Update last_recalled_at for returned memories
            if (memories && memories.length > 0) {
              const ids = memories.map((m) => m.id);
              await supabase
                .from("agent_memory")
                .update({ last_recalled_at: new Date().toISOString() })
                .in("id", ids);
            }

            toolResult = JSON.stringify({
              memories: memories || [],
              count: (memories || []).length,
              instruction: "Use these lessons to inform your current analysis and trading decisions. If any lesson is confirmed or contradicted by new evidence, use update_memory to adjust it.",
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Recall failed: " + e.message });
          }
        }

        // ── save_insight ──
        else if (fnName === "save_insight") {
          try {
            const { data: memory, error: memError } = await supabase
              .from("agent_memory")
              .insert({
                memory_type: args.memoryType,
                title: args.title,
                content: args.content,
                source_type: args.relatedTradeIds?.length ? "trade_outcome" : "reflection",
                tags: args.tags || [],
                strategy_id: args.strategyId || null,
                confidence: args.confidence ?? 0.5,
                related_trade_ids: args.relatedTradeIds || [],
              })
              .select()
              .single();

            if (memError) throw memError;

            toolResult = JSON.stringify({
              success: true,
              memory,
              message: `Saved ${args.memoryType}: "${args.title}" (confidence: ${((args.confidence ?? 0.5) * 100).toFixed(0)}%)`,
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Save failed: " + e.message });
          }
        }

        // ── update_memory ──
        else if (fnName === "update_memory") {
          try {
            const { data: existing } = await supabase
              .from("agent_memory")
              .select("*")
              .eq("id", args.memoryId)
              .single();

            if (!existing) throw new Error("Memory not found");

            const updates: any = { updated_at: new Date().toISOString() };

            if (args.action === "confirm") {
              updates.confirmations = (existing.confirmations || 0) + 1;
              // Boost confidence by 10%, cap at 0.95
              updates.confidence = Math.min(0.95, (existing.confidence || 0.5) + 0.1);
            } else if (args.action === "contradict") {
              updates.contradictions = (existing.contradictions || 0) + 1;
              // Lower confidence by 15%, floor at 0.05 — never deactivate automatically
              updates.confidence = Math.max(0.05, (existing.confidence || 0.5) - 0.15);
            } else if (args.action === "deactivate") {
              updates.is_active = false;
            } else if (args.action === "update_content" && args.newContent) {
              updates.content = args.newContent;
            }

            const { data: updated } = await supabase
              .from("agent_memory")
              .update(updates)
              .eq("id", args.memoryId)
              .select()
              .single();

            toolResult = JSON.stringify({
              success: true,
              memory: updated,
              message: `Memory "${existing.title}" ${args.action}ed. Confidence: ${((updated?.confidence || 0) * 100).toFixed(0)}%${args.reason ? ` Reason: ${args.reason}` : ""}`,
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Update failed: " + e.message });
          }
        }

        // ── execute_basket ──
        else if (fnName === "execute_basket") {
          try {
            const basketUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-basket`;
            const basketResp = await fetch(basketUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                strategy_id: args.strategyId || null,
                strategy_name: args.strategy || null,
                alert_id: args.alert_id || null,
                legs: args.legs,
                mode,
                user_id: userId,
                expected_edge_cents: args.expected_edge_cents || 0,
                reasoning: args.reasoning || "",
              }),
            });
            const basketResult = await basketResp.json();
            toolResult = JSON.stringify({
              ...basketResult,
              instruction: basketResult.success
                ? `Basket completed. All ${basketResult.legs_filled} legs filled.`
                : `Basket ${basketResult.status}: ${basketResult.abort_reason || "see leg_results"}. ${basketResult.flatten_results?.length ? `${basketResult.flatten_results.length} legs flattened to prevent exposure.` : ""}`,
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Basket execution failed: " + e.message });
          }
        }

        // ── fetch_signals ──
        else if (fnName === "fetch_signals") {
          try {
            const sigUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/signal-generator`;
            const sigResp = await fetch(sigUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                limit: args.limit || 20,
                category: args.category || undefined,
              }),
            });
            if (!sigResp.ok) {
              const errText = await sigResp.text();
              toolResult = JSON.stringify({ error: `signal-generator error: ${errText}` });
            } else {
              const sigData = await sigResp.json();
              toolResult = JSON.stringify({
                ...sigData,
                instruction: "These signals are pre-scored. Focus on 'strong' signals with direction != 'skip'. Use fetch_live_markets for deeper orderbook data on specific tickers before trading.",
              });
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Signal fetch failed: " + e.message });
          }
        }

        // ── scan_surface ──
        else if (fnName === "scan_surface") {
          try {
            const scanUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/surface-scanner`;
            const scanResp = await fetch(scanUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                min_edge_cents: args.min_edge_cents || 3,
              }),
            });
            if (!scanResp.ok) {
              const errText = await scanResp.text();
              toolResult = JSON.stringify({ error: `surface-scanner error: ${errText}` });
            } else {
              const scanData = await scanResp.json();
              toolResult = JSON.stringify({
                ...scanData,
                instruction: "Prioritize monotonicity_violations (near-riskless arb) and high-confidence bracket_sum_violations. Each alert includes a specific 'action' field describing what trade to make.",
              });
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Surface scan failed: " + e.message });
          }
        }

        // ── search_web ──
        else if (fnName === "search_web") {
          try {
            const tavilyKey = Deno.env.get("TAVILY_API_KEY");
            if (!tavilyKey) {
              toolResult = JSON.stringify({ error: "Web search not configured — add TAVILY_API_KEY secret" });
            } else {
              const resp = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  api_key: tavilyKey,
                  query: args.query,
                  search_depth: "basic",
                  max_results: 5,
                  ...(args.focus ? { topic: args.focus } : {}),
                }),
              });
              if (!resp.ok) {
                toolResult = JSON.stringify({ error: `Tavily error: ${resp.status}` });
              } else {
                const data = await resp.json();
                const results = (data.results || []).map((r: any) => ({
                  title: r.title,
                  url: r.url,
                  content: r.content?.slice(0, 400),
                }));
                toolResult = JSON.stringify({ query: args.query, results });
              }
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Web search failed: " + e.message });
          }
        }

        // ── create_strategy ──
        else if (fnName === "create_strategy") {
          try {
            const { data: newStrategy, error: insertErr } = await supabase
              .from("strategies")
              .insert({
                name: args.name,
                instructions: args.instructions,
                market_types: args.market_types || [],
                active: false,
                mode: "paper",
                user_id: userId,
              })
              .select("id, name")
              .single();
            if (insertErr) throw new Error(insertErr.message);
            toolResult = JSON.stringify({
              success: true,
              strategy_id: newStrategy.id,
              message: `Strategy "${newStrategy.name}" created (inactive). Activate it in the Strategies tab to start trading.`,
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Strategy creation failed: " + e.message });
          }
        }

        // ── trigger_strategy_run ──
        else if (fnName === "trigger_strategy_run") {
          try {
            const autoTradeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/auto-trade`;
            const resp = await fetch(autoTradeUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ strategy_id: args.strategy_id, run_mode: "manual" }),
            });
            const runData = await resp.json();
            toolResult = JSON.stringify({
              success: resp.ok,
              strategy_id: args.strategy_id,
              result: runData,
              message: resp.ok
                ? `Strategy ${args.strategy_id} run triggered. Check Trade Log for new trades.`
                : `Run failed: ${JSON.stringify(runData)}`,
            });
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Trigger failed: " + e.message });
          }
        }

        // ── Unknown tool ──
        else {
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
      return await streamAnthropicAsSSE(finalModel, keys["anthropic"], aiMessages, temperature ?? 0.3);
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
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
