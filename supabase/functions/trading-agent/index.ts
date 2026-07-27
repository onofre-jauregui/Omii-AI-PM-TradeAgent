import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersExtended as corsHeaders, preflight } from "../_shared/cors.ts";
import { KALSHI_BASE_URL, getKalshiCredentials, generateAuthHeaders, fetchWithRetry } from "../_shared/kalshi-auth.ts";
import { importMasterKey, decryptSecret } from "../_shared/encryption.ts";

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
        keyword: { type: "string", description: "Free-text search across all Kalshi markets by title/topic. NOTE: Kalshi search is unreliable — prefer category when possible." },
        title_contains: { type: "string", description: "After fetching, keep only markets whose title contains this substring (case-insensitive). Use to pre-filter results — e.g. '>61' when user asked about above 61°, or 'May 23' to restrict to a specific date. Applied server-side before returning results." },
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

const QUERY_TRADES_TOOL = {
  type: "function",
  function: {
    name: "query_trades",
    description: "Search past trades with flexible filters. Use when the user asks about trades on a specific date, for a ticker, by strategy, or by outcome (wins/losses).",
    parameters: {
      type: "object",
      properties: {
        date_start: { type: "string", description: "ISO date string, e.g. '2026-05-01'. If omitted, no lower bound." },
        date_end: { type: "string", description: "ISO date string, e.g. '2026-05-20'. Defaults to today." },
        ticker: { type: "string", description: "Filter by market ticker, e.g. 'KXBTC-25MAY2026-B65000'." },
        strategy: { type: "string", description: "Filter by strategy name or ID, e.g. 'S-002' or 'Longshot Bias'." },
        outcome: { type: "string", enum: ["win", "loss", "any"], description: "Filter by trade outcome. 'win' = pnl > 0, 'loss' = pnl < 0." },
        status: { type: "string", enum: ["settled", "filled", "any"], description: "Trade status. Default 'any'." },
        limit: { type: "number", description: "Max trades to return. Default 20, max 50." },
      },
      required: [],
    },
  },
};

const REMEMBER_TOOL = {
  type: "function",
  function: {
    name: "remember",
    description: "Save something the user wants remembered across all future conversations — a preference, a goal, a fact about how they trade, or an instruction. Use when the user says 'remember that...', 'always...', 'I prefer...', 'my rule is...', etc.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The preference or fact to remember, in plain language." },
        category: {
          type: "string",
          enum: ["preference", "goal", "rule", "fact", "instruction"],
          description: "What kind of thing this is."
        },
      },
      required: ["content", "category"],
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
): Promise<{ result: any; usage: { input_tokens: number | null; output_tokens: number | null } }> {
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
  const raw = await resp.json();
  return {
    result: fromAnthropicResponse(raw),
    usage: { input_tokens: raw?.usage?.input_tokens ?? null, output_tokens: raw?.usage?.output_tokens ?? null },
  };
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
    const { messages: rawMessages, strategies, model, temperature, systemPrompt, tradingMode, conversationId: incomingConversationId, message: incomingMessage } = body;
    let messages = rawMessages;

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

    // ── Open SSE stream immediately — processing happens in background ──
    // This ensures the client gets the response header right away rather than
    // waiting for DB queries + LLM calls to complete before any bytes are sent.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const streamWriter = writable.getWriter();
    const enc = new TextEncoder();
    const sendStatus = async (text: string) => {
      try { await streamWriter.write(enc.encode(`data: ${JSON.stringify({ type: "status", text })}\n\n`)); } catch {}
    };
    const sseResponse = new Response(readable, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });

    // All processing runs in this IIFE; return sseResponse immediately below.
    (async () => {
      try {

    // Extract JWT before parallel fetch so we can include auth in the batch.
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
    const jwt = authHeader?.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
    const authPromise = jwt && jwt !== supabaseKey
      ? supabase.auth.getUser(jwt)
      : Promise.resolve({ data: { user: null }, error: null });

    // ── Load all startup data in parallel (was 7 sequential awaits ~700ms; now one round-trip) ──
    const MAY_START = "2026-05-01T00:00:00.000Z";
    const [
      authSettled,
      keyRowsSettled,
      savedModelSettled,
      memorySettled,
      tradesSettled,
      unreflectedSettled,
    ] = await Promise.allSettled([
      authPromise,
      supabase.from("api_keys").select("provider, secret_ciphertext, secret_iv, encrypted_secret").in("provider", ["openrouter", "openai", "anthropic", "google"]),
      supabase.from("api_keys").select("key_id").eq("provider", "model_agent").maybeSingle(),
      // NOTE: risk_settings is fetched in the SECOND batch below, after userId
      // resolves — it is per (user_id, mode) and an unscoped query here matches
      // multiple rows and errors.
      supabase.from("agent_memory")
        .select("id, memory_type, title, content, summary, tags, confidence, strategy_id, child_count, created_at")
        .eq("is_active", true)
        .is("merged_into", null)
        .order("confidence", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(30),
      supabase.from("trades")
        .select("ticker, side, action, price, amount, pnl, strategy, settled_at")
        .eq("status", "settled")
        .gte("settled_at", MAY_START)
        .order("settled_at", { ascending: false })
        .limit(20),
      supabase.from("trades")
        .select("id")
        .eq("status", "settled")
        .not("id", "in", "(SELECT trade_id FROM trade_reflections)")
        .limit(1),
    ]);

    // Resolve userId early so profile fetch can be user-scoped
    if (authSettled.status === "fulfilled" && authSettled.value?.data?.user?.id) {
      userId = authSettled.value.data.user.id;
    }

    // Load profile + user_preference memories + risk_settings in parallel (userId now known).
    // risk_settings is per (user_id, mode); scope by both so we don't match multiple rows.
    const riskMode: "paper" | "live" = tradingMode === "live" ? "live" : "paper";
    const [profileSettled, prefMemoriesSettled, riskSettled] = await Promise.allSettled([
      userId
        ? supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      userId
        ? supabase.from("agent_memory")
            .select("id, title, content, summary, tags, confidence, created_at")
            .eq("is_active", true)
            .eq("memory_type", "user_preference")
            .or(`user_id.is.null,user_id.eq.${userId}`)
            .order("confidence", { ascending: false })
            .limit(20)
        : Promise.resolve({ data: null, error: null }),
      userId
        ? supabase.from("risk_settings").select("*").eq("user_id", userId).eq("mode", riskMode).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    // Extract values — any failed query falls back to null/[] to match prior behavior
    // userId already resolved above from authSettled
    const keyRows = keyRowsSettled.status === "fulfilled" ? (keyRowsSettled.value?.data ?? []) : [];
    const savedModelData = savedModelSettled.status === "fulfilled" ? (savedModelSettled.value?.data ?? null) : null;
    const riskSettings = riskSettled.status === "fulfilled" ? (riskSettled.value?.data ?? null) : null;

    const displayName: string | null =
      profileSettled.status === "fulfilled" ? (profileSettled.value?.data?.display_name ?? null) : null;
    const userPrefMemories =
      prefMemoriesSettled.status === "fulfilled" ? (prefMemoriesSettled.value?.data ?? []) : [];

    // Re-fetch trading memories scoped to this user (excludes user_preference — those are in userPrefMemories).
    // The initial batch query above was unscoped; replace with the user-scoped result.
    let topMemories = memorySettled.status === "fulfilled" ? (memorySettled.value?.data ?? null) : null;
    if (userId) {
      const { data: scopedMemories } = await supabase
        .from("agent_memory")
        .select("id, memory_type, title, content, summary, tags, confidence, strategy_id, child_count, created_at")
        .eq("is_active", true)
        .is("merged_into", null)
        .neq("memory_type", "user_preference")
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order("confidence", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(30);
      if (scopedMemories) topMemories = scopedMemories;
    }
    const recentFilledTrades = tradesSettled.status === "fulfilled" ? (tradesSettled.value?.data ?? null) : null;
    const unreflectedTrades = unreflectedSettled.status === "fulfilled" ? (unreflectedSettled.value?.data ?? null) : null;

    // ── Conversation persistence ──
    // Track the current user message text so we can save it after the LLM responds.
    const userMessage: string = incomingMessage || (messages[messages.length - 1]?.role === "user" ? messages[messages.length - 1].content : "") || "";
    let activeConversationId: string | null = incomingConversationId ?? null;

    if (userId) {
      if (!activeConversationId) {
        const title = userMessage.slice(0, 60) || "New conversation";
        const { data: newConv } = await supabase.from("conversations").insert({
          user_id: userId,
          title,
        }).select("id").single();
        activeConversationId = newConv?.id ?? null;
      }

      // Load the last 40 messages from DB and use as authoritative history.
      // The client sends its in-session rolling window; DB has the cross-session history.
      if (activeConversationId) {
        const { data: priorMessages } = await supabase
          .from("chat_messages")
          .select("role, content")
          .eq("conversation_id", activeConversationId)
          .order("created_at", { ascending: true })
          .limit(40);

        if (priorMessages && priorMessages.length > 0) {
          messages = priorMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
        }
      }

      // Emit conversationId to frontend so it can be stored in localStorage.
      if (activeConversationId) {
        await streamWriter.write(enc.encode(`data: ${JSON.stringify({ type: "conversation_id", conversationId: activeConversationId })}\n\n`));
      }
    }

    const keys: Record<string, string> = {};
    const masterKeyBase64 = Deno.env.get("API_KEY_ENCRYPTION_KEY");
    for (const row of keyRows || []) {
      let resolved: string | undefined;
      // Primary: AES-256-GCM columns (keys saved via save-ai-key endpoint)
      if (row.secret_ciphertext && row.secret_iv && masterKeyBase64) {
        try {
          const masterKey = await importMasterKey(masterKeyBase64);
          resolved = await decryptSecret({ ciphertext: row.secret_ciphertext, iv: row.secret_iv }, masterKey);
        } catch (e) {
          console.error(`trading-agent: decrypt failed for ${row.provider}:`, e instanceof Error ? e.message : e);
        }
      }
      // Fallback: legacy plaintext in encrypted_secret (until re-saved via Settings)
      if (!resolved && row.encrypted_secret) resolved = row.encrypted_secret;
      if (resolved) keys[row.provider] = resolved;
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
      resolvedModel = savedModelData?.key_id || "openai/gpt-4o-mini";
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

    let riskContext = "";
    if (riskSettings) {
      riskContext = `\n\n## Risk Limits (Enforced)\n- Max position size: $${riskSettings.max_position_size}\n- Max daily loss: $${riskSettings.max_daily_loss}\n- Max drawdown: ${riskSettings.max_drawdown_pct}%\n- Max open positions: ${riskSettings.max_open_positions}\n- Auto stop-loss: ${riskSettings.auto_stop_loss ? "Enabled" : "Disabled"} at ${riskSettings.stop_loss_pct}%\nThese limits are enforced server-side. Orders exceeding limits will be rejected.`;
    }

    // ── Build persistent memory block (data already loaded in parallel above) ──
    const MEMORY_TOKEN_BUDGET = 1500; // max ~1500 tokens for memory block
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

    const activeMemoryIds = (topMemories ?? []).map((m: any) => m.id);

    // ── Build performance block (data already loaded in parallel above) ──
    // P&L only exists on settled trades; filled trades always have pnl=0
    let performanceBlock = "";
    if (recentFilledTrades && recentFilledTrades.length > 0) {
      const totalPnl = recentFilledTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
      const wins = recentFilledTrades.filter((t) => (Number(t.pnl) || 0) > 0).length;
      const losses = recentFilledTrades.filter((t) => (Number(t.pnl) || 0) < 0).length;
      const neutral = recentFilledTrades.length - wins - losses;
      performanceBlock = `\n\n## Recent Performance (last ${recentFilledTrades.length} trades)\n- Total P&L: $${totalPnl.toFixed(2)}\n- Wins: ${wins} | Losses: ${losses} | Neutral: ${neutral}\n- Win rate: ${recentFilledTrades.length > 0 ? ((wins / recentFilledTrades.length) * 100).toFixed(0) : 0}%\nUse reflect_on_trades to analyze patterns in these results.\n`;
    }

    // ── Check for unreflected settled trades (data already loaded in parallel above) ──
    const hasUnreflected = (unreflectedTrades?.length || 0) > 0;
    const reflectionHint = hasUnreflected
      ? "\n\n> **Note:** You have trades that haven't been reflected on yet. Consider calling `reflect_on_trades` to learn from recent outcomes.\n"
      : "";

    // ── Build per-user identity block ──
    // Loads the user's display name and persisted preferences so the agent
    // addresses them by name and applies their rules from the first message.
    let userIdentityBlock = "";
    {
      const nameStr = displayName
        ? `**${displayName}**`
        : "unknown (you haven't introduced yourself yet — on first message, ask the user for their name and use the `remember` tool to save it)";

      let prefLines = "";
      if (userPrefMemories && userPrefMemories.length > 0) {
        prefLines = userPrefMemories.map(m => `- ${m.title}: ${m.summary || m.content}`).join("\n");
      }

      userIdentityBlock =
        `\n\n## About This User\nYou are speaking with ${nameStr}. Address them by first name when natural.\n` +
        (prefLines
          ? `\n**Their preferences and rules:**\n${prefLines}\n\nAlways apply these preferences — they persist across all conversations.`
          : `\nNo preferences saved yet. As you learn about how they trade and what they care about, use the \`remember\` tool to build their profile.`);
    }

    const nowUtc = new Date();
    const todayStr = nowUtc.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
    const timeStr = nowUtc.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });

    const baseSystemPrompt =
      systemPrompt ||
      `You are an expert algorithmic trading agent for Kalshi event contracts.\n\n## Current Date & Time\nToday is **${todayStr}** (${timeStr}). Always use this date when the user asks about trades "today", "this week", or any relative time reference. Never guess or invent a date.`;

    const fullSystemPrompt =
      baseSystemPrompt +
      userIdentityBlock +
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
2. Call fetch_live_markets with category=<series_ticker> AND title_contains=<direction+threshold> — always pass title_contains to pre-filter server-side. Examples:
   - User says "above 61°" → title_contains=">61"
   - User says "below 54°" → title_contains="<54"
   - User says "between 60 and 61" → title_contains="60-61"
   - Also add the date if the user specified one: title_contains=">61° on May 23"
   NEVER use keyword (it is broken and returns wrong results)
3. Number and present the top 1–3 returned markets, most liquid first (server already filtered by direction — no further filtering needed):
   **1.** Will the high temp in NYC be 69–70°F on May 22?
   Ticker: KXHIGHNY-26MAY22-B69.5 | YES: 42c | NO: 58c | Closes: May 22

   **2.** Will the high temp in NYC be >70°F on May 22?
   Ticker: KXHIGHNY-26MAY22-T70 | YES: 2c | NO: 98c | Closes: May 22

4. Ask: "Which one do you want? (reply with number + yes/no)"
5. On reply, extract the market number and direction from ANY natural phrasing. "one yes", "do 1", "let's go two no", "yes on 3", "the first one yes", "Do one, yes" all count — never ask for re-confirmation of format. If you can identify a number (1/2/3) and a direction (yes/no), execute immediately.

If no series ticker maps to their request, call fetch_live_markets with NO parameters (returns broad market list) and scan visually. Never tell the user "I couldn't find it" without first trying at least one category fetch.

## Tool Workflow

**User-initiated trades (no ticker provided):** map topic → fetch_live_markets(category=series) → present 1–3 matches → confirm direction → execute_trade
**User-initiated trades (ticker provided):** execute_trade directly
**Autonomous analysis:** recall_lessons → fetch_signals → scan_surface → check_portfolio → execute → save_insight/reflect_on_trades

- Arb alerts (monotonicity_violation, bracket_sum_violation): **execute_basket** only — never execute_trade for 2-leg arb (naked exposure risk)
- Single-leg signals: **execute_trade** with reasoning + expectedOutcome + confidenceLevel
- composite_score ≥ 0.65 = strong; direction "skip" = pass
- Kalshi prices in cents (1-99); YES+NO=100; use LIMIT orders; wide spread = low liquidity

## Memory Tools Available
- **remember**: User says "remember that I prefer X", "always do X", "my rule is X" → call remember(). Category: preference/goal/rule/fact/instruction. This persists across all future conversations.
- **recall_lessons**: Find past insights by tags or text. Call when the user references a past decision, asks "what do you know about X", or when market context warrants checking past lessons.
- **query_trades**: User asks about past trades. "What trades did I make last Tuesday?", "Show me my weather market losses", "How did S-002 do this month?" → call query_trades() with appropriate filters. When the user references a date or asks about past trades, always use query_trades() — never guess from memory.
- **save_insight**: For trading-domain lessons (market observations, strategy patterns). Different from remember() which is for user preferences.

## Conversation Memory
Save user preferences via save_insight (tag "user_preference"): risk limits, market interests, style, strategy directives. Use memoryType "lesson", "market_note", or "strategy_insight".

Format responses with markdown. Be transparent about reasoning and risk.

## Price Units
All market prices in fetch_live_markets results are in INTEGER CENTS (1–99). Use these values directly as the price parameter in execute_trade. Do NOT convert or divide. A market showing yes_ask_cents=2 means the limit price is 2.

## Error Handling
If execute_trade returns a non-success response, print the FULL JSON exactly as received, prefixed with "Raw error:". Do NOT summarize it as "authentication error" or "JWT error" — print it verbatim. Never fabricate next steps based on guessed error causes.

For user-initiated manual trades (not triggered by a strategy run), set strategy=null and strategyId=null in execute_trade. Strategy IDs are only for autonomous cron-triggered strategy runs.`;

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
      QUERY_TRADES_TOOL,
      REMEMBER_TOOL,
      SEARCH_WEB_TOOL,
      CREATE_STRATEGY_TOOL,
      TRIGGER_STRATEGY_RUN_TOOL,
    ];

    // ── Kill switch check ── halt before any LLM calls if trading is globally halted
    if (userId) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: riskStateRow } = await supabase
        .from("risk_state")
        .select("is_trading_halted")
        .eq("user_id", userId)
        .eq("date", today)
        .maybeSingle();
      if (riskStateRow?.is_trading_halted) {
        await streamWriter.write(enc.encode(`data: ${JSON.stringify({ type: "content", content: "⛔ Trading is currently halted for your account. No trades can be placed until the halt is lifted in your risk settings." })}\n\n`));
        await streamWriter.write(enc.encode("data: [DONE]\n\n"));
        await streamWriter.close();
        return;
      }
    }

    const aiMessages = [{ role: "system", content: fullSystemPrompt }, ...messages];
    let maxIterations = 12; // Supports: recall → fetch_signals → scan_surface → portfolio → fetch_markets → trade chains
    let fullReply = ""; // Accumulated assistant reply for persistence

    while (maxIterations > 0) {
      maxIterations--;

      let result: any;
      const turnIndex = 12 - maxIterations;

      const llmCallStart = Date.now();

      if (effectiveProvider === "anthropic") {
        const { result: anthropicResult, usage: anthropicUsage } = await callAnthropicNonStream(finalModel, keys["anthropic"], aiMessages, allTools, temperature ?? 0.3);
        result = anthropicResult;
        const durationMs = Date.now() - llmCallStart;
        if (supabase && anthropicUsage.input_tokens != null) {
          supabase.from("compliance_log").insert({
            event_type: "chat_llm_usage",
            severity: "info",
            user_id: userId ?? null,
            message: `chat: ${anthropicUsage.input_tokens} in / ${anthropicUsage.output_tokens ?? "?"} out · turn ${turnIndex} · ${durationMs}ms`,
            metadata: {
              model: finalModel,
              provider: "anthropic",
              prompt_tokens: anthropicUsage.input_tokens,
              completion_tokens: anthropicUsage.output_tokens,
              total_tokens: (anthropicUsage.input_tokens ?? 0) + (anthropicUsage.output_tokens ?? 0),
              turn_index: turnIndex,
              duration_ms: durationMs,
            },
          }).then(() => {}).catch(() => {});
        }
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
          if (status === 429) throw new Error("Rate limit exceeded. Please wait and try again.");
          if (status === 402) throw new Error("Usage credits depleted. Please add credits to your AI provider.");
          const t = await resp.text();
          console.error("AI error:", status, t);
          let errMsg = `AI provider error (HTTP ${status})`;
          try {
            const parsed = JSON.parse(t);
            errMsg = parsed?.error?.message || parsed?.message || parsed?.error || errMsg;
          } catch {}
          throw new Error(errMsg);
        }
        result = await resp.json();
        const durationMs = Date.now() - llmCallStart;
        if (supabase && result?.usage) {
          supabase.from("compliance_log").insert({
            event_type: "chat_llm_usage",
            severity: "info",
            user_id: userId ?? null,
            message: `chat: ${result.usage.prompt_tokens ?? "?"} in / ${result.usage.completion_tokens ?? "?"} out · turn ${turnIndex} · ${durationMs}ms`,
            metadata: {
              model: finalModel,
              provider: effectiveProvider,
              prompt_tokens: result.usage.prompt_tokens ?? null,
              completion_tokens: result.usage.completion_tokens ?? null,
              total_tokens: result.usage.total_tokens ?? null,
              turn_index: turnIndex,
              duration_ms: durationMs,
            },
          }).then(() => {}).catch(() => {});
        }
      }

      const choice = result.choices?.[0];
      if (!choice) throw new Error("No response from AI");

      // No tool calls — write the already-received content directly to the stream.
      // This avoids a second LLM round-trip (the old approach called streamAnthropicAsSSE
      // which re-sent the full conversation to get a streaming response we already had).
      if (choice.finish_reason !== "tool_calls" || !choice.message?.tool_calls?.length) {
        const content = choice.message?.content || "";
        fullReply = content;
        await streamWriter.write(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        // Persist the exchange before closing the stream
        if (userId && activeConversationId && userMessage && fullReply) {
          await Promise.all([
            supabase.from("chat_messages").insert([
              { conversation_id: activeConversationId, user_id: userId, role: "user", content: userMessage },
              { conversation_id: activeConversationId, user_id: userId, role: "assistant", content: fullReply },
            ]),
            supabase.from("conversations").update({
              updated_at: new Date().toISOString(),
            }).eq("id", activeConversationId),
          ]);
        }
        await streamWriter.write(enc.encode("data: [DONE]\n\n"));
        return;
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

        // ── Emit status event so user sees progress during tool execution ──
        {
          const statusLabels: Record<string, string> = {
            fetch_live_markets: `Searching ${args.category ? args.category + " " : ""}markets…`,
            execute_trade: `Placing ${String(args.side || "").toUpperCase() || "trade"} order on ${args.ticker || "market"}…`,
            execute_basket: "Executing basket trade…",
            check_portfolio: "Loading portfolio…",
            fetch_signals: "Scoring live markets…",
            scan_surface: "Scanning for arb opportunities…",
            recall_lessons: "Reading agent memory…",
            save_insight: "Saving insight…",
            update_memory: "Updating memory…",
            reflect_on_trades: "Analyzing trade history…",
            query_trades: "Searching trade history…",
            remember: "Saving preference…",
          };
          const label = statusLabels[fnName];
          if (label) await sendStatus(label);
        }

        // ── fetch_live_markets ──
        if (fnName === "fetch_live_markets") {
          try {
            const limit = args.limit || 10;
            const kalshiBase = KALSHI_BASE_URL;

            // Helper: parse a market into a compact object.
            // Prices are normalized to integer CENTS (1-99) so the LLM passes the
            // correct value directly to execute_trade without unit conversion.
            const toCents = (v: any): number => {
              const n = Number(v) || 0;
              // Kalshi API returns dollars (0.01–0.99) via *_dollars fields, cents (1–99) via raw fields.
              // If the value is < 1 it's in dollars — multiply by 100 and round.
              return n > 0 && n < 1 ? Math.round(n * 100) : Math.round(n);
            };
            const parseMarket = (m: any) => {
              const ya = toCents(m.yes_ask_dollars ?? m.yes_ask);
              const yb = toCents(m.yes_bid_dollars ?? m.yes_bid);
              return {
                ticker: m.ticker,
                title: m.title || m.subtitle,
                yes_bid_cents: yb,
                yes_ask_cents: ya,
                no_bid_cents: toCents(m.no_bid_dollars ?? m.no_bid),
                no_ask_cents: toCents(m.no_ask_dollars ?? m.no_ask),
                last_price_cents: toCents(m.last_price_dollars ?? m.last_price),
                volume: m.volume,
                volume_24h: m.volume_24h,
                open_interest: m.open_interest,
                close_time: m.close_time,
                spread_cents: ya - yb,
              };
            };

            // Helper: is this a real tradeable market?
            const isLiquid = (m: any): boolean => {
              if ((m.ticker || "").startsWith("KXMVE")) return false;
              const ya = toCents(m.yes_ask_dollars ?? m.yes_ask);
              const yb = toCents(m.yes_bid_dollars ?? m.yes_bid);
              const last = toCents(m.last_price_dollars ?? m.last_price);
              return ya >= 1 || yb >= 1 || last >= 1; // values are now in cents
            };

            let allMarkets: any[] = [];

            // These are public read-only endpoints, but plain fetch() with no
            // headers hits Kalshi's lowest (anonymous) rate tier — the same
            // 429-causing bug just fixed in kalshi-proxy (2026-07-26). Sign with
            // the service-tenant credential when available; fall back to
            // unauthenticated only if it's missing, same as kalshi-proxy.
            let kalshiHeaders: Record<string, string> = {};
            const { keyId: serviceKeyId, privateKey: servicePrivateKey } =
              await getKalshiCredentials(supabase, null);
            if (serviceKeyId && servicePrivateKey) {
              kalshiHeaders = await generateAuthHeaders(
                serviceKeyId, servicePrivateKey, "GET", "/trade-api/v2/markets", Date.now()
              );
            }

            if (args.keyword) {
              // Free-text keyword search across all Kalshi markets
              const encoded = encodeURIComponent(args.keyword);
              const url = `${kalshiBase}/markets?limit=50&status=open&search=${encoded}`;
              const res = await fetch(url, { headers: kalshiHeaders });
              const data = await res.json();
              allMarkets = (data.markets || []).map(parseMarket);
            } else if (args.category) {
              // Series ticker fetch
              const url = `${kalshiBase}/markets?limit=${Math.min(limit * 3, 60)}&status=open&series_ticker=${args.category}`;
              const res = await fetch(url, { headers: kalshiHeaders });
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
                fetch(`${kalshiBase}/markets?limit=20&status=open&series_ticker=${s}`, { headers: kalshiHeaders })
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

            // Apply title_contains filter server-side before slicing
            if (args.title_contains) {
              const needle = String(args.title_contains).toLowerCase();
              allMarkets = allMarkets.filter(m =>
                (m.title || "").toLowerCase().includes(needle)
              );
            }

            const finalMarkets = allMarkets.slice(0, limit);
            if (finalMarkets.length === 0) {
              toolResult = JSON.stringify({ markets: [], note: `No markets found${args.title_contains ? ` matching "${args.title_contains}"` : args.keyword ? ` for "${args.keyword}"` : ""}. Kalshi may not have active markets on this topic right now.` });
            } else {
              toolResult = JSON.stringify({ markets: finalMarkets, total_found: allMarkets.length });
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "Failed to fetch Kalshi markets: " + e.message });
          }
        }

        // ── execute_trade ──
        // Paper trades: insert directly into DB using the service-role client already
        // in scope — no HTTP boundary, no JWT auth issue.
        // Live trades: forward to execute-trade function which handles Kalshi auth,
        // entitlement checks, and risk management.
        else if (fnName === "execute_trade") {
          try {
            if (mode === "paper") {
              // ── Inline paper trade ───────────────────────────────────────────
              const { data: trade, error: insertError } = await supabase
                .from("trades")
                .insert({
                  user_id: userId,
                  ticker: args.ticker,
                  market_id: args.ticker,
                  market_question: args.marketQuestion || args.ticker,
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
                  notes: `Agent trade: ${args.reasoning || ""}`,
                })
                .select()
                .single();

              if (insertError) throw insertError;

              // Trade reflection if agent provided expected outcome
              if (args.expectedOutcome) {
                await supabase.from("trade_reflections").insert({
                  trade_id: trade.id,
                  expected_outcome: args.expectedOutcome,
                  expected_confidence: args.confidenceLevel || null,
                  decision_quality: "unknown",
                });
              }

              // Compliance log
              await supabase.from("compliance_log").insert({
                user_id: userId,
                trade_id: trade.id,
                event_type: "order_filled",
                severity: "info",
                message: `Paper trade filled: ${args.action} ${args.side} ${args.ticker} @ ${args.price}c for $${args.amount}`,
                metadata: { mode: "paper", reasoning: args.reasoning },
              });

              // Increment daily trade count in risk_state
              const today = new Date().toISOString().split("T")[0];
              const riskQuery = userId
                ? supabase.from("risk_state").select("daily_trades").eq("user_id", userId).eq("date", today).maybeSingle()
                : supabase.from("risk_state").select("daily_trades").is("user_id", null).eq("date", today).maybeSingle();
              const { data: rs } = await riskQuery;
              await supabase.from("risk_state").upsert(
                {
                  user_id: userId,
                  date: today,
                  daily_trades: (rs?.daily_trades ?? 0) + 1,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: userId ? "user_id,date" : "date" }
              );

              toolResult = JSON.stringify({
                success: true,
                trade,
                message: `Paper trade: ${String(args.action).toUpperCase()} ${String(args.side).toUpperCase()} ${args.ticker} @ ${args.price}c for $${args.amount}`,
              });
            } else {
              // ── Live trade — forward to execute-trade function ──────────────
              const execUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-trade`;
              const execResp = await fetch(execUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${supabaseKey}`,
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
                  mode: "live",
                  user_id: userId,
                  notes: `Agent trade: ${args.reasoning}`,
                  expectedOutcome: args.expectedOutcome || null,
                  confidenceLevel: args.confidenceLevel || null,
                  influencedByMemoryIds: activeMemoryIds,
                }),
              });
              const rawText = await execResp.text();
              let execResult: any;
              try { execResult = JSON.parse(rawText); } catch { execResult = { raw: rawText }; }
              toolResult = JSON.stringify(execResult);
            }
          } catch (e: any) {
            toolResult = JSON.stringify({ success: false, error: "Trade execution failed: " + e.message });
          }
        }

        // ── cancel_order ──
        else if (fnName === "cancel_order") {
          try {
            // Live mode: cancel on Kalshi FIRST, and only mark the local trade
            // row cancelled if Kalshi confirms it. The previous version fired
            // an unauthenticated, unchecked DELETE (no HMAC headers at all —
            // Kalshi rejects this) and marked the DB row cancelled regardless,
            // so a still-resting live order could fill later while our system
            // believed it was long closed, with reconcile-orders never
            // re-checking it (it only polls status IN ('open','partial')).
            if (mode === "live") {
              const { keyId, privateKey } = await getKalshiCredentials(supabase, userId);
              if (!keyId || !privateKey) {
                toolResult = JSON.stringify({ success: false, error: "No Kalshi credentials configured for this account — cancel not attempted." });
              } else {
                const path = `/trade-api/v2/portfolio/orders/${args.orderId}`;
                const ts = Date.now();
                const headers = await generateAuthHeaders(keyId, privateKey, "DELETE", path, ts);
                const res = await fetchWithRetry(`${KALSHI_BASE_URL}/portfolio/orders/${args.orderId}`, { method: "DELETE", headers });

                if (!res.ok) {
                  const bodyText = await res.text().catch(() => "");
                  await supabase.from("compliance_log").insert({
                    event_type: "order_cancel_failed",
                    severity: "error",
                    message: `Kalshi DELETE order ${args.orderId} failed (status ${res.status}) — local trade row left unchanged, order may still be live`,
                    metadata: { order_id: args.orderId, status: res.status, raw_body: bodyText.slice(0, 500) },
                  });
                  toolResult = JSON.stringify({ success: false, error: `Kalshi rejected the cancel (status ${res.status}) — order may still be live, local record left unchanged.` });
                } else {
                  const { data: trades } = await supabase
                    .from("trades")
                    .update({
                      status: "cancelled",
                      cancelled_at: new Date().toISOString(),
                      notes: `Cancelled by agent: ${args.reason}`,
                    })
                    .eq("order_id", args.orderId)
                    .select();

                  await supabase.from("compliance_log").insert({
                    trade_id: trades?.[0]?.id || null,
                    event_type: "order_cancelled",
                    severity: "info",
                    message: `Order ${args.orderId} cancelled: ${args.reason}`,
                    metadata: { order_id: args.orderId, reason: args.reason },
                  });

                  toolResult = JSON.stringify({ success: true, message: `Order ${args.orderId} cancelled: ${args.reason}` });
                }
              }
            } else {
              // Paper mode: no live order to cancel — DB is the only source of truth.
              const { data: trades } = await supabase
                .from("trades")
                .update({
                  status: "cancelled",
                  cancelled_at: new Date().toISOString(),
                  notes: `Cancelled by agent: ${args.reason}`,
                })
                .eq("order_id", args.orderId)
                .select();

              await supabase.from("compliance_log").insert({
                trade_id: trades?.[0]?.id || null,
                event_type: "order_cancelled",
                severity: "info",
                message: `Order ${args.orderId} cancelled: ${args.reason}`,
                metadata: { order_id: args.orderId, reason: args.reason },
              });

              toolResult = JSON.stringify({ success: true, message: `Order ${args.orderId} cancelled: ${args.reason}` });
            }
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

        // ── query_trades ──
        else if (fnName === "query_trades") {
          try {
            const { date_start, date_end, ticker, strategy, outcome, status, limit = 20 } = args;
            // Use OR-null pattern: return the user's trades + any trades with no user_id (placed
            // before multi-tenancy enforcement). Falls back to no filter if userId is null.
            let q = supabase.from("trades").select("id, ticker, side, action, price, amount, pnl, strategy, status, settled_at, created_at");
            if (userId) q = q.or(`user_id.is.null,user_id.eq.${userId}`);
            if (date_start) q = q.gte("created_at", date_start);
            if (date_end) q = q.lte("created_at", date_end + "T23:59:59Z");
            if (ticker) q = q.ilike("ticker", `%${ticker}%`);
            if (strategy) q = q.or(`strategy.ilike.%${strategy}%,strategy_id.ilike.%${strategy}%`);
            if (status && status !== "any") q = q.eq("status", status);
            if (outcome === "win") q = q.gt("pnl", 0);
            if (outcome === "loss") q = q.lt("pnl", 0);
            q = q.order("created_at", { ascending: false }).limit(Math.min(limit, 50));
            const { data: trades, error } = await q;
            toolResult = JSON.stringify({ trades: trades || [], count: (trades || []).length, error: error?.message });
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "query_trades failed: " + e.message });
          }
        }

        // ── remember ──
        else if (fnName === "remember") {
          try {
            const { content, category } = args;
            const title = content.slice(0, 80);
            const { data: saved, error } = await supabase.from("agent_memory").insert({
              user_id: userId,
              memory_type: "user_preference",
              title,
              content,
              source_type: "user_feedback",
              tags: [category, "user_preference"],
              confidence: 0.95,
              is_active: true,
            }).select("id").single();
            toolResult = error
              ? JSON.stringify({ ok: false, error: error.message })
              : JSON.stringify({ ok: true, id: saved?.id, message: `Remembered: "${title}"` });
          } catch (e: any) {
            toolResult = JSON.stringify({ error: "remember failed: " + e.message });
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
    // Fallback after max iterations exhausted — write whatever we have
    const lastContent = aiMessages.filter((m: any) => m.role === "assistant").pop()?.content || "Max iterations reached without a final response.";
    fullReply = lastContent;
    await streamWriter.write(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: lastContent } }] })}\n\n`));
    if (userId && activeConversationId && userMessage && fullReply) {
      await Promise.all([
        supabase.from("chat_messages").insert([
          { conversation_id: activeConversationId, user_id: userId, role: "user", content: userMessage },
          { conversation_id: activeConversationId, user_id: userId, role: "assistant", content: fullReply },
        ]),
        supabase.from("conversations").update({
          updated_at: new Date().toISOString(),
        }).eq("id", activeConversationId),
      ]);
    }
    await streamWriter.write(enc.encode("data: [DONE]\n\n"));

      } catch (e: any) {
        console.error("trading-agent error:", e);
        const errText = e instanceof Error ? e.message : "Unknown error";
        try {
          await streamWriter.write(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\nError: ${errText}` } }] })}\n\n`));
          await streamWriter.write(enc.encode("data: [DONE]\n\n"));
        } catch {}
      } finally {
        try { await streamWriter.close(); } catch {}
      }
    })();

    return sseResponse;

  } catch (e) {
    console.error("trading-agent setup error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
