import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

/**
 * compact-memory: Compresses the agent's memory to save tokens.
 *
 * Two phases:
 * 1. SUMMARIZE: Generate 1-line summaries for memories that don't have one.
 *    Uses a lightweight AI call to compress full content → ~20 word summary.
 *
 * 2. MERGE: Find clusters of related memories (same type + overlapping tags)
 *    and merge them into a single summary memory. Original memories are
 *    deactivated and linked via merged_into.
 *
 * Called by auto-reflect hourly, or manually.
 */


// Rough token estimate: ~4 chars per token for English
function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const results: Record<string, any> = { summarized: 0, merged: 0, tokens_saved: 0 };

  try {
    // ── Load AI key for summarization ──
    const { data: keyRows } = await supabase
      .from("api_keys")
      .select("provider, encrypted_secret")
      .in("provider", ["openrouter", "openai"]);

    const keys: Record<string, string> = {};
    for (const row of keyRows || []) {
      if (row.encrypted_secret) keys[row.provider] = row.encrypted_secret;
    }
    if (!keys["openrouter"]) keys["openrouter"] = Deno.env.get("OPENROUTER_API_KEY") || "";
    if (!keys["openai"]) keys["openai"] = Deno.env.get("OPENAI_API_KEY") || "";

    // Pick cheapest available model for summarization
    const aiKey = keys["openrouter"] || keys["openai"];
    const aiBaseUrl = keys["openrouter"]
      ? "https://openrouter.ai/api/v1"
      : "https://api.openai.com/v1";
    const aiModel = keys["openrouter"]
      ? "openai/gpt-4o-mini"
      : "gpt-4o-mini";

    // ── Phase 1: SUMMARIZE — create 1-line summaries ──────────

    const { data: unsummarized } = await supabase
      .from("agent_memory")
      .select("id, title, content, memory_type, tags")
      .eq("is_active", true)
      .is("summary", null)
      .order("created_at", { ascending: true })
      .limit(20); // batch 20 at a time to control cost

    if (unsummarized && unsummarized.length > 0 && aiKey) {
      // Batch summarize with a single AI call; truncate content to keep input small
      const memoriesToSummarize = unsummarized.map(
        (m, i) => `[${i + 1}] (${m.memory_type}) ${m.title}: ${(m.content || "").slice(0, 300)}`
      ).join("\n\n");

      const summaryResp = await fetch(`${aiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: aiModel,
          messages: [
            {
              role: "system",
              content: "You compress trading insights into ultra-short summaries. For each numbered memory, output ONLY a single line: the number followed by a colon and a summary of max 25 words. No extra text.",
            },
            {
              role: "user",
              content: `Summarize each memory in max 25 words:\n\n${memoriesToSummarize}`,
            },
          ],
          temperature: 0,
          max_tokens: 1000,
        }),
      });

      if (summaryResp.ok) {
        const data = await summaryResp.json();
        const summaryText = data.choices?.[0]?.message?.content || "";

        // Same event_type/shape as auto-trade's qualify-call logging so the
        // Observability cost dashboard (ObservabilityPage.tsx) picks this up for
        // free — compact-memory's summarize/merge calls were previously invisible.
        if (data.usage?.prompt_tokens != null || data.usage?.completion_tokens != null) {
          await supabase.from("compliance_log").insert({
            event_type: "llm_usage",
            severity: "info",
            message: `compact-memory summarize: ${data.usage?.prompt_tokens ?? "?"} in / ${data.usage?.completion_tokens ?? "?"} out`,
            metadata: {
              model: aiModel,
              provider: keys["openrouter"] ? "openrouter" : "openai",
              prompt_tokens: data.usage?.prompt_tokens ?? null,
              completion_tokens: data.usage?.completion_tokens ?? null,
              total_tokens: data.usage?.total_tokens ?? null,
              source: "compact-memory-summarize",
            },
          }).then(undefined, () => {});
        }

        // Parse numbered summaries
        const lines = summaryText.split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          const match = line.match(/^\[?(\d+)\]?\s*[:.\-–]\s*(.+)/);
          if (!match) continue;
          const idx = parseInt(match[1], 10) - 1;
          const summary = match[2].trim();
          if (idx >= 0 && idx < unsummarized.length && summary) {
            const mem = unsummarized[idx];
            const tokenEst = estimateTokens(summary);
            const tokensSaved = estimateTokens(mem.content) - tokenEst;
            await supabase.from("agent_memory").update({
              summary,
              token_estimate: tokenEst,
              updated_at: new Date().toISOString(),
            }).eq("id", mem.id);
            results.summarized++;
            results.tokens_saved += Math.max(0, tokensSaved);
          }
        }
      }
    }

    // ── Phase 2: MERGE — combine related memories ─────────────
    // Find memories of the same type with overlapping tags.
    // Group clusters of 3+ similar memories into one merged memory.

    const { data: activeMemories } = await supabase
      .from("agent_memory")
      .select("id, user_id, title, content, summary, memory_type, tags, confidence, strategy_id, related_trade_ids, confirmations, contradictions, created_at")
      .eq("is_active", true)
      .is("merged_into", null) // not already merged
      .order("confidence", { ascending: false });

    if (activeMemories && activeMemories.length > 0) {
      // Market category extractor — keeps weather/crypto/equity lessons from merging together
      const getMarketCategory = (tags: string[]): string => {
        if (tags.some((t: string) => ["weather", "kxhigh", "temperature", "forecast_bias"].includes(t))) return "weather";
        if (tags.some((t: string) => ["kxbtc", "kxeth", "crypto"].includes(t))) return "crypto";
        if (tags.some((t: string) => ["kxinx", "equity", "sp500"].includes(t))) return "equity";
        if (tags.some((t: string) => ["kxfed", "rates", "federal_reserve"].includes(t))) return "rates";
        return "other";
      };

      // Group by (user_id, memory_type, strategy_id, lesson_type, market_category).
      // Previously grouped only by (user_id, memory_type, strategy_id) — this merged e.g.
      // weather forecast_bias lessons with crypto market_timing lessons, destroying specificity.
      const groups: Record<string, typeof activeMemories> = {};
      for (const mem of activeMemories) {
        const lessonType = (mem.tags || []).find((t: string) =>
          ["forecast_bias", "signal_quality", "market_timing", "market_structure", "execution"].includes(t)
        ) || "general";
        const category = getMarketCategory(mem.tags || []);
        const key = `${mem.user_id || "platform"}::${mem.memory_type}::${mem.strategy_id || "global"}::${lessonType}::${category}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(mem);
      }

      for (const [groupKey, members] of Object.entries(groups)) {
        if (members.length < 3) continue; // only merge when 3+ exist

        // Within each group, find tag-overlap clusters
        const clusters: typeof members[] = [];
        const used = new Set<string>();

        for (let i = 0; i < members.length; i++) {
          if (used.has(members[i].id)) continue;
          const cluster = [members[i]];
          used.add(members[i].id);
          const baseTags = new Set(members[i].tags || []);

          for (let j = i + 1; j < members.length; j++) {
            if (used.has(members[j].id)) continue;
            const otherTags = members[j].tags || [];
            // Need at least 1 overlapping tag (besides "user_preference")
            const overlap = otherTags.filter(
              (t: string) => baseTags.has(t) && t !== "user_preference"
            );
            if (overlap.length > 0) {
              cluster.push(members[j]);
              used.add(members[j].id);
              // Expand base tags
              for (const t of otherTags) baseTags.add(t);
            }
          }
          if (cluster.length >= 3) {
            clusters.push(cluster);
          }
        }

        // Merge each cluster — cap at 3 merges per run to avoid rate limits
        const MAX_MERGES_PER_RUN = 3;
        for (const cluster of clusters) {
          if (!aiKey) break;
          if (results.merged >= MAX_MERGES_PER_RUN * 3) break; // merged counts members, not clusters

          // Use summary when available; truncate content fallback to 200 chars
          const clusterText = cluster.map(
            (m, i) => `${i + 1}. ${m.title}: ${(m.summary || m.content || "").slice(0, 200)}`
          ).join("\n");

          const mergeResp = await fetch(`${aiBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${aiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: aiModel,
              messages: [
                {
                  role: "system",
                  content: "You merge multiple trading filter rules into one actionable memory. Output exactly two lines:\nLine 1: A title (max 10 words)\nLine 2: A merged rule in IF/THEN format (max 150 words) that lists ALL specific conditions, price thresholds, cities, and market categories from the originals. Do NOT generalize away any specific number or condition. If rules conflict, keep the most conservative version.",
                },
                {
                  role: "user",
                  content: `Merge these ${cluster.length} related trading rules into one IF/THEN rule that preserves every specific condition:\n\n${clusterText}`,
                },
              ],
              temperature: 0,
              max_tokens: 400,
            }),
          });

          if (!mergeResp.ok) continue;

          const mergeData = await mergeResp.json();
          const mergeText = mergeData.choices?.[0]?.message?.content || "";

          if (mergeData.usage?.prompt_tokens != null || mergeData.usage?.completion_tokens != null) {
            await supabase.from("compliance_log").insert({
              event_type: "llm_usage",
              severity: "info",
              message: `compact-memory merge: ${mergeData.usage?.prompt_tokens ?? "?"} in / ${mergeData.usage?.completion_tokens ?? "?"} out`,
              metadata: {
                model: aiModel,
                provider: keys["openrouter"] ? "openrouter" : "openai",
                prompt_tokens: mergeData.usage?.prompt_tokens ?? null,
                completion_tokens: mergeData.usage?.completion_tokens ?? null,
                total_tokens: mergeData.usage?.total_tokens ?? null,
                source: "compact-memory-merge",
              },
            }).then(undefined, () => {});
          }
          const mergeLines = mergeText.split("\n").filter((l: string) => l.trim());
          if (mergeLines.length < 2) continue;

          const mergedTitle = mergeLines[0].replace(/^(title:\s*)/i, "").trim();
          const mergedContent = mergeLines.slice(1).join(" ").replace(/^(insight|content|merged):\s*/i, "").trim();
          // Summary is a 50-word condensation of content for the context window
          const words = mergedContent.split(/\s+/);
          const mergedSummary = words.length > 50
            ? words.slice(0, 50).join(" ") + "..."
            : mergedContent;

          // Compute merged stats
          const allTags = [...new Set(cluster.flatMap(m => m.tags || []))];
          const allTradeIds = [...new Set(cluster.flatMap(m => m.related_trade_ids || []))];
          const totalConfirmations = cluster.reduce((s, m) => s + (m.confirmations || 0), 0);
          const totalContradictions = cluster.reduce((s, m) => s + (m.contradictions || 0), 0);
          // Weight confidence by confirmations so a well-validated memory dominates
          const weightedConfidence = totalConfirmations > 0
            ? cluster.reduce((s, m) => s + (m.confidence || 0.5) * (m.confirmations || 0), 0) / totalConfirmations
            : cluster.reduce((s, m) => s + (m.confidence || 0.5), 0) / cluster.length;
          const [type, strategyId] = groupKey.split("::");

          // Create merged memory
          const { data: merged } = await supabase
            .from("agent_memory")
            .insert({
              memory_type: type,
              title: mergedTitle,
              content: mergedContent,
              summary: mergedSummary,
              source_type: "reflection",
              tags: allTags,
              strategy_id: strategyId === "global" ? null : strategyId,
              confidence: Math.min(0.95, weightedConfidence),
              confirmations: totalConfirmations,
              contradictions: totalContradictions,
              related_trade_ids: allTradeIds,
              token_estimate: estimateTokens(mergedSummary),
              child_count: cluster.length,
            })
            .select("id")
            .single();

          if (merged) {
            // Keep originals active — link them to the merged memory so the
            // context window query (merged_into IS NULL) excludes them, but
            // recall_lessons can still retrieve them for deep inspection.
            const clusterIds = cluster.map(m => m.id);
            await supabase.from("agent_memory").update({
              merged_into: merged.id,
              updated_at: new Date().toISOString(),
            }).in("id", clusterIds);

            results.merged += cluster.length;
            const tokensBefore = cluster.reduce(
              (s, m) => s + estimateTokens(m.summary || m.content), 0
            );
            results.tokens_saved += Math.max(0, tokensBefore - estimateTokens(mergedSummary));
          }
        }
      }
    }

    // Log results
    await supabase.from("compliance_log").insert({
      event_type: "memory_compaction",
      severity: "info",
      message: `Memory compaction: ${results.summarized} summarized, ${results.merged} merged, ~${results.tokens_saved} tokens saved`,
      metadata: results,
    });

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error("compact-memory error:", e);

    try {
      await supabase.from("compliance_log").insert({
        event_type: "compact_memory_error",
        severity: "critical",
        message: `compact-memory CRASHED: ${errMsg}`,
        metadata: { stack: e instanceof Error ? e.stack : undefined, partial_results: results },
      });
    } catch { /* don't let the error handler throw */ }

    // Unbounded memory growth degrades signal quality and inflates LLM costs.
    await sendTelegramAlert(
      `🚨 <b>[TradeAgent] compact-memory CRASHED</b>\n` +
      `Agent memory is no longer being compressed — context costs will grow until this is fixed.\n` +
      `Error: ${errMsg.slice(0, 300)}`
    ).catch(() => {});

    return new Response(
      JSON.stringify({ error: errMsg, partial_results: results }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
