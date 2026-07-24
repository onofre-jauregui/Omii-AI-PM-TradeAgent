import { useEffect, useState } from "react";
import { useStrategies } from "@/lib/strategiesContext";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

interface StrategyStoriesProps {
  mode: "paper" | "live";
  onNavigate: (tab: string) => void;
}

const STRATEGY_META: Record<string, { label: string; short: string; fallbackInsight: string }> = {
  "S-001": { label: "01", short: "Arb",     fallbackInsight: "Scans for bracket-sum and spread anomalies across Kalshi markets" },
  "S-002": { label: "02", short: "Fade",    fallbackInsight: "Fades sentiment-driven overreactions near resolution" },
  "S-003": { label: "03", short: "Macro",   fallbackInsight: "Trades economic series when Kalshi diverges from analyst consensus" },
  "S-005": { label: "05", short: "Weather", fallbackInsight: "Exploits GFS forecast edges in weather prediction markets" },
};

const ORDER = ["S-001", "S-002", "S-003", "S-005"];

function getRingClass(pnl: number, active: boolean, isActive: boolean): string {
  const base = isActive ? "p-[3px]" : "p-[2px]";
  if (!active) return `${base} bg-zinc-700`;
  if (pnl > 50)  return `${base} bg-gradient-to-br from-emerald-400 to-green-500`;
  if (pnl > 0)   return `${base} bg-gradient-to-br from-teal-400 to-emerald-500`;
  if (pnl < -50) return `${base} bg-gradient-to-br from-red-500 to-rose-400`;
  if (pnl < 0)   return `${base} bg-gradient-to-br from-orange-400 to-amber-500`;
  return `${base} bg-gradient-to-br from-blue-400 to-indigo-500`;
}

function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;
}

export function StrategyStories({ mode, onNavigate }: StrategyStoriesProps) {
  const { strategies, strategyStats } = useStrategies();
  const [insights, setInsights] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState(0);

  // Pull most-recent agent_memory lesson per strategy as the insight line
  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("agent_memory")
        .select("strategy_id, content")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(30);
      if (!data) return;
      const map: Record<string, string> = {};
      for (const row of data) {
        // Normalise "S-001-abc123" → "S-001"
        const tid = (row.strategy_id ?? "").replace(/[-_][a-f0-9]{6,}$/i, "").toUpperCase();
        if (!map[tid] && row.content) map[tid] = row.content;
      }
      setInsights(map);
    }
    load();
  }, []);

  // Auto-advance focused story every 4s
  useEffect(() => {
    const t = setInterval(() => setFocused(i => (i + 1) % 4), 4000);
    return () => clearInterval(t);
  }, []);

  // Build 4 cards — prefer current mode, fall back to paper template for display
  const cards = ORDER.map(tid => {
    const modeMatch = strategies.find(s => s.template_id === tid && s.mode === mode);
    const paperMatch = strategies.find(s => s.template_id === tid && s.mode === "paper");
    return { strategy: modeMatch ?? paperMatch ?? null, ghost: !modeMatch, tid };
  });

  if (cards.every(c => !c.strategy)) return null;

  const focusedCard = cards[focused];
  const focusedMeta = STRATEGY_META[focusedCard?.tid ?? ""] ?? { label: "--", short: "", fallbackInsight: "" };
  const focusedStats = focusedCard?.strategy ? strategyStats[focusedCard.strategy.id] : null;
  const focusedInsight =
    insights[focusedCard?.tid ?? ""] ??
    (focusedStats && focusedStats.totalTrades > 0
      ? `${focusedStats.winRate}% win rate · ${focusedStats.totalTrades} trades`
      : focusedMeta.fallbackInsight);

  return (
    <div className="space-y-3">
      {/* Rotating insight strip */}
      <button
        onClick={() => onNavigate("markets")}
        className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors active:scale-[0.99]"
        style={{ background: "var(--secondary)" }}
      >
        <span className="text-base shrink-0">{focusedMeta.label}</span>
        <span className="flex-1 text-xs text-muted-foreground leading-snug line-clamp-2">
          {focusedInsight}
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </button>

    </div>
  );
}
