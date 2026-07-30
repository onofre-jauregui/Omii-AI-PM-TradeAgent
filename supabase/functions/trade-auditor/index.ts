import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * trade-auditor v1: Post-settlement learning loop.
 *
 * Called by auto-settle after each ticker settles. For every settled trade:
 *   1. Pulls the trade row + original signal + forecast snapshot
 *   2. Asks the LLM to extract structured lessons (what happened, why, do differently)
 *   3. Writes lessons to trade_lessons with retrieval tags
 *
 * auto-trade S-005 reads recent relevant lessons before qualifying each signal,
 * giving the LLM real experience rather than just priors.
 *
 * Lesson types:
 *   forecast_bias    — model consistently over/under predicts for a city
 *   market_timing    — edge erodes or prices move before we trade
 *   signal_quality   — signal was noise, bad data, or wrong date
 *   execution        — sizing, fill, or position management issue
 *   market_structure — Kalshi market behaved unexpectedly
 *   general          — anything else worth remembering
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_LESSON_TYPES = ["forecast_bias", "market_timing", "signal_quality", "execution", "market_structure", "general"] as const;
type LessonType = typeof VALID_LESSON_TYPES[number];

interface LessonDraft {
  lesson_type: LessonType;
  lesson: string;
  do_differently: string;
  confidence: number;
  tags: string[];
}

// ─── LLM audit prompt ─────────────────────────────────────────────────────────

function buildAuditPrompt(ctx: Record<string, any>): string {
  return `You are auditing a completed paper trade on Kalshi prediction markets.
Your job is to extract 1-3 concrete lessons that will make future trades better.

== TRADE CONTEXT ==
Ticker: ${ctx.ticker}
Market question: ${ctx.market_question ?? "unknown"}
Strategy: ${ctx.strategy_id ?? "S-005"}
Side: ${ctx.side} (bought ${ctx.side === "yes" ? "YES" : "NO"})
Entry price: ${ctx.price}¢/contract
Amount at risk: $${ctx.amount}
Outcome: ${ctx.outcome?.toUpperCase()} | P&L: $${ctx.pnl?.toFixed?.(2) ?? "0"}

== SIGNAL DATA (what the model saw before trading) ==
Edge: ${ctx.edge_cents ?? "?"}¢
Model true probability: ${ctx.true_probability ?? "?"}
Implied (market) probability: ${ctx.implied_probability ?? "?"}
Forecast expected high: ${ctx.forecast_expected_high ?? "?"}°F
Forecast std dev: ${ctx.forecast_std_dev ?? "?"}°F
Forecast source: ${ctx.forecast_source ?? "unknown"}
Location: ${ctx.location ?? "unknown"}

== ACTUAL OUTCOME ==
Kalshi resolution: ${ctx.resolution?.toUpperCase() ?? "unknown"}
Settlement note: ${ctx.settlement_note ?? "none"}

== PREVIOUS LESSONS FOR THIS LOCATION (for context) ==
${ctx.prior_lessons?.length > 0
  ? ctx.prior_lessons.map((l: any, i: number) => `${i + 1}. [${l.lesson_type}] ${l.lesson}`).join("\n")
  : "No prior lessons yet — this is the first trade for this location."}

== YOUR TASK ==
Extract 1-3 lessons. Each lesson should be:
- Specific and actionable (not "be more careful")
- Focused on what the system can actually change (forecast, signal threshold, timing, sizing)
- Honest about whether the loss/win was skill or luck

For each lesson, output EXACTLY this JSON block (no markdown, no extra text):
{
  "lessons": [
    {
      "lesson_type": "forecast_bias|market_timing|signal_quality|execution|market_structure|general",
      "lesson": "One to three sentences: what happened and why.",
      "do_differently": "Concrete change: e.g. raise edge threshold to 15¢ for Austin in spring, or add NWS bias correction of +3°F for Miami.",
      "confidence": 0.0-1.0,
      "tags": ["weather", "austin", "april", "temperature", "gfs"]
    }
  ]
}`;
}

// ─── Resolve AI config ────────────────────────────────────────────────────────

async function resolveAiConfig(supabase: any): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
  const { data: keyRows } = await supabase
    .from("api_keys")
    .select("provider, encrypted_secret")
    .in("provider", ["openrouter", "openai"]);
  const keyMap = new Map((keyRows || []).map((r: any) => [r.provider, r.encrypted_secret]));
  const openrouterKey = keyMap.get("openrouter") || Deno.env.get("OPENROUTER_API_KEY");
  const openaiKey = keyMap.get("openai") || Deno.env.get("OPENAI_API_KEY");
  if (openrouterKey) return { apiKey: openrouterKey, baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" };
  if (openaiKey) return { apiKey: openaiKey, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  return null;
}

// ─── Call LLM for lessons ─────────────────────────────────────────────────────

async function extractLessons(aiConfig: { apiKey: string; baseUrl: string; model: string }, prompt: string): Promise<LessonDraft[]> {
  const resp = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${aiConfig.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://omii-ai-pm-trade-agent.vercel.app",
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content ?? "";

  // Parse JSON from response (handle markdown code fences if present)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in LLM response: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]);
  const lessons: LessonDraft[] = (parsed.lessons || []).filter((l: any) =>
    l.lesson_type && l.lesson && VALID_LESSON_TYPES.includes(l.lesson_type)
  ).map((l: any) => ({
    lesson_type: l.lesson_type as LessonType,
    lesson: String(l.lesson).slice(0, 500),
    do_differently: String(l.do_differently ?? "").slice(0, 300),
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0.7)),
    tags: Array.isArray(l.tags) ? l.tags.map(String).slice(0, 10) : [],
  }));

  return lessons.slice(0, 3); // max 3 lessons per trade
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing credentials" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Accept: { trade_ids: string[] } — list of trade IDs to audit
  // or { ticker: string } — audit all settled trades for a ticker
  let body: any = {};
  try { body = await req.json(); } catch { /* GET or empty body */ }

  const runId = crypto.randomUUID();
  const results: any[] = [];

  try {
    // ── Resolve which trades to audit ──────────────────────────────────────────
    let tradeQuery = supabase
      .from("trades")
      .select("id, ticker, market_question, side, action, price, amount, pnl, resolution, strategy_id, strategy, settled_at, filled_at")
      .eq("mode", "paper")
      .not("settled_at", "is", null)
      .not("resolution", "is", null)
      .not("resolution", "eq", "");

    if (body.trade_ids?.length > 0) {
      tradeQuery = tradeQuery.in("id", body.trade_ids);
    } else if (body.ticker) {
      tradeQuery = tradeQuery.eq("ticker", body.ticker);
    } else {
      // Default: audit trades settled in last 24h that don't have lessons yet
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      tradeQuery = tradeQuery.gte("settled_at", dayAgo);
    }

    const { data: trades, error: tradesErr } = await tradeQuery.limit(20);
    if (tradesErr) throw new Error(`Trades fetch: ${tradesErr.message}`);
    if (!trades || trades.length === 0) {
      return new Response(JSON.stringify({ success: true, run_id: runId, audited: 0, message: "No trades to audit" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Skip trades that already have lessons ──────────────────────────────────
    const tradeIds = trades.map((t: any) => t.id);
    const { data: existingLessons } = await supabase
      .from("trade_lessons")
      .select("trade_id")
      .in("trade_id", tradeIds);
    const auditedIds = new Set((existingLessons || []).map((l: any) => l.trade_id));
    const toAudit = trades.filter((t: any) => !auditedIds.has(t.id));

    if (toAudit.length === 0) {
      return new Response(JSON.stringify({ success: true, run_id: runId, audited: 0, message: "All trades already have lessons" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiConfig = await resolveAiConfig(supabase);
    if (!aiConfig) throw new Error("No AI API key configured");

    // ── Audit each trade ───────────────────────────────────────────────────────
    for (const trade of toAudit) {
      try {
        // Pull the original signal for this trade (match by ticker + time window)
        const signalWindow = new Date(new Date(trade.filled_at).getTime() - 35 * 60 * 1000).toISOString();
        const { data: signals } = await supabase
          .from("signals")
          .select("edge_cents, true_probability, implied_probability, metadata, source")
          .eq("ticker", trade.ticker)
          .eq("source", "weather_signal_s005")
          .gte("created_at", signalWindow)
          .order("created_at", { ascending: false })
          .limit(1);

        const signal = signals?.[0] ?? {};
        const meta = signal.metadata ?? {};

        // Pull prior lessons for same location to give the LLM context
        const location = meta.location ?? trade.ticker.split("-")[0];
        const { data: priorLessons } = await supabase
          .from("trade_lessons")
          .select("lesson_type, lesson, do_differently, confidence")
          .contains("tags", [location.toLowerCase()])
          .order("created_at", { ascending: false })
          .limit(5);

        const outcome = (trade.pnl ?? 0) > 0 ? "win" : (trade.pnl ?? 0) < 0 ? "loss" : "void";

        const ctx = {
          ticker: trade.ticker,
          market_question: trade.market_question,
          strategy_id: trade.strategy_id ?? trade.strategy,
          side: trade.side,
          price: trade.price,
          amount: trade.amount,
          outcome,
          pnl: trade.pnl,
          resolution: trade.resolution,
          edge_cents: signal.edge_cents,
          true_probability: signal.true_probability,
          implied_probability: signal.implied_probability,
          forecast_expected_high: meta.forecast_expected_high,
          forecast_std_dev: meta.forecast_std_dev,
          forecast_source: signal.source,
          location: meta.location,
          settlement_note: null,
          prior_lessons: priorLessons ?? [],
        };

        const prompt = buildAuditPrompt(ctx);
        const lessons = await extractLessons(aiConfig, prompt);

        if (lessons.length === 0) {
          results.push({ trade_id: trade.id, ticker: trade.ticker, status: "no_lessons_extracted" });
          continue;
        }

        // Write lessons to DB
        const lessonRows = lessons.map((l) => ({
          trade_id: trade.id,
          ticker: trade.ticker,
          strategy_id: trade.strategy_id ?? trade.strategy,
          outcome,
          lesson_type: l.lesson_type,
          lesson: l.lesson,
          do_differently: l.do_differently,
          confidence: l.confidence,
          tags: l.tags,
          trade_context: ctx,
        }));

        const { error: insertErr } = await supabase.from("trade_lessons").insert(lessonRows);
        if (insertErr) {
          console.error(`Lesson insert failed for ${trade.ticker}:`, insertErr.message);
          results.push({ trade_id: trade.id, ticker: trade.ticker, status: "insert_failed", error: insertErr.message });
        } else {
          results.push({ trade_id: trade.id, ticker: trade.ticker, status: "ok", lessons_written: lessons.length, outcome });
        }

        await supabase.from("compliance_log").insert({
          event_type: "trade_audited",
          severity: "info",
          trade_id: trade.id,
          message: `Audited ${trade.ticker} (${outcome}): ${lessons.length} lesson(s) written`,
          metadata: { run_id: runId, lessons: lessonRows.map(l => ({ type: l.lesson_type, lesson: l.lesson })) },
        });

      } catch (tradeErr) {
        const msg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        console.error(`Audit failed for ${trade.ticker}:`, msg);
        results.push({ trade_id: trade.id, ticker: trade.ticker, status: "error", error: msg });
      }
    }

    const okCount = results.filter(r => r.status === "ok").length;
    return new Response(JSON.stringify({ success: true, run_id: runId, audited: toAudit.length, lessons_written: okCount, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("trade-auditor fatal:", msg);
    return new Response(JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
