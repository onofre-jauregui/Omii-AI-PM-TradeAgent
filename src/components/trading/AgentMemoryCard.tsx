import { Brain, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface MemoryEntry {
  id: string;
  memory_type: string;
  title: string;
  content: string;
  confidence: number;
  is_active: boolean;
  tags: string[] | null;
  strategy_id: string | null;
  created_at: string;
}

const TYPE_COLOR: Record<string, string> = {
  lesson:           "bg-primary/10 text-primary",
  market_note:      "bg-yellow-500/10 text-yellow-500",
  strategy_insight: "bg-purple-500/10 text-purple-500",
  user_preference:  "bg-emerald-500/10 text-emerald-500",
};

function confidenceBar(conf: number) {
  const pct = Math.round(conf * 100);
  const color = pct >= 70 ? "bg-profit" : pct >= 40 ? "bg-yellow-500" : "bg-loss";
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="w-12 h-1 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

export function AgentMemoryCard({ full = false }: { full?: boolean }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await (supabase.from("agent_memory" as any) as any)
      .select("id, memory_type, title, content, confidence, is_active, tags, strategy_id, created_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setMemories(data as MemoryEntry[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = full || expanded ? memories : memories.slice(0, 5);

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">Agent Memory</h3>
          {!loading && (
            <span className="text-[10px] text-muted-foreground">
              {memories.length} active
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="px-5 py-6 text-xs text-muted-foreground text-center">Loading…</div>
      ) : memories.length === 0 ? (
        <div className="px-5 py-6 text-xs text-muted-foreground text-center">
          No memories yet. The agent learns as it trades.
        </div>
      ) : (
        <>
          <div className="divide-y divide-border">
            {visible.map((m) => (
              <div key={m.id} className="px-5 py-3.5 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span className={`text-[9px] font-medium rounded-full px-1.5 py-0.5 shrink-0 ${TYPE_COLOR[m.memory_type] ?? "bg-secondary text-muted-foreground"}`}>
                      {m.memory_type.replace("_", " ")}
                    </span>
                    {m.strategy_id && (
                      <span className="text-[9px] text-muted-foreground font-mono">{m.strategy_id}</span>
                    )}
                  </div>
                  {confidenceBar(m.confidence)}
                </div>
                <p className="text-xs font-medium text-foreground leading-snug">{m.title}</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{m.content}</p>
              </div>
            ))}
          </div>

          {!full && memories.length > 5 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-full flex items-center justify-center gap-1.5 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors border-t border-border"
            >
              {expanded ? (
                <><ChevronUp className="h-3.5 w-3.5" /> Show less</>
              ) : (
                <><ChevronDown className="h-3.5 w-3.5" /> Show {memories.length - 5} more</>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}
