import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { tradesKeys, fetchSettledTrades } from "@/lib/queries/trades";

export interface Strategy {
  id: string;
  template_id?: string;
  name: string;
  description: string;
  instructions: string;
  active: boolean;
  mode: "paper" | "live";
  starting_balance: number;
}

export interface StrategyStats {
  strategyId: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  winRate: number;
  roi: number;
  balance: number;
}

interface StrategiesContextType {
  strategies: Strategy[];
  strategyStats: Record<string, StrategyStats>;
  instanceExists: Record<string, { paper: boolean; live: boolean }>;
  loading: boolean;
  updateStrategy: (id: string, updates: Partial<Strategy>) => void;
  addStrategy: (strategy: Omit<Strategy, "id">) => void;
  deleteStrategy: (id: string) => void;
  getActiveStrategies: () => Strategy[];
  refreshStats: () => Promise<void>;
}

const StrategiesContext = createContext<StrategiesContextType | null>(null);

function generateStrategyId(): string {
  // Random per-user id, never a bare template id. The old sequential scheme
  // matched /^S-(\d+)$/ against the user's own strategies — post-onboarding
  // every id is suffixed (S-001-ab12cd34), so nothing matched, it always
  // returned "S-001", and the insert died on a PK collision with the seeded
  // system row. Combined with the unchecked insert error below, "New Strategy"
  // rendered a card that silently vanished on the next load — the button has
  // never once produced a persisted strategy. A bare random id also cannot
  // collide with template ids, so it can never inherit a template's
  // entitlement by name (see checkEntitlement's exact-match rule).
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `custom-${rand}`;
}

export function StrategiesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyStats, setStrategyStats] = useState<Record<string, StrategyStats>>({});
  const [loading, setLoading] = useState(true);

  // Load strategies from DB
  const loadStrategies = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? "";
    const { data, error } = await supabase
      .from("strategies")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (!error && data) {
      setStrategies(data.map(s => ({
        id: s.id,
        template_id: s.template_id ?? undefined,
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        active: s.active,
        mode: s.mode as "paper" | "live",
        starting_balance: s.starting_balance,
      })));
    } else {
      // Fallback defaults if DB not ready — display only, not used for routing
      setStrategies([
        {
          id: "S-001", template_id: "S-001", name: "Surface Arbitrage", mode: "paper", starting_balance: 500, active: true,
          description: "Exploit structural price inconsistencies between related Kalshi markets — monotonicity violations, bracket sum gaps, and spread anomalies detected by the surface scanner.",
          instructions: "Always start by calling scan_surface. Prioritize monotonicity violations (lower threshold priced cheaper than higher threshold — near-riskless arb). Then bracket sum violations where sum of YES < 85¢. Then spread anomalies — post limit orders at the mid. Size $15–$50 depending on alert type. Do not trade alerts with confidence < 0.3.",
        },
        {
          id: "S-002", template_id: "S-002", name: "Resolution Fade", mode: "paper", starting_balance: 1000, active: true,
          description: "Fade overreaction price moves in markets 2–7 days from resolution. Prediction market participants systematically overreact to recent news near expiry.",
          instructions: "Use fetch_signals filtered to time_value_score >= 0.7 and edge_score >= 0.4. For each candidate, judge: was the price move caused by a confirmed fundamental (skip) or sentiment/rumor (fade)? Fade sentiment-driven extremes with $20–$40 limit orders. Exit when price reverts 10¢ toward prior range. Hard stop if price moves 10¢ further against you.",
        },
        {
          id: "S-003", template_id: "S-003", name: "Economic Consensus", mode: "paper", starting_balance: 1000, active: true,
          description: "Trade KXFED, KXCPI, KXPAYROLLS, KXGDP toward analyst consensus when Kalshi prices diverge from professional forecasts by more than 15¢.",
          instructions: "Focus on KXFED, KXCPI, KXPAYROLLS, KXGDP, KXCHCUTS series. For each market, reason from your training data and saved memories about the current professional consensus forecast. When Kalshi mid price diverges from consensus-implied probability by >= 15¢, trade toward consensus. Size $30–$75. Never hold through the data release unless conviction is high.",
        },
        {
          id: "S-004", template_id: "S-004", name: "Liquidity Provision", mode: "paper", starting_balance: 1000, active: false,
          description: "Post limit orders near the mid on liquid, range-bound markets to passively collect the bid-ask spread. Low directional risk.",
          instructions: "Use fetch_signals to find markets with liquidity_score >= 0.5, spread >= 6¢, mid between 30¢–70¢, and no catalyst within 48h. Post YES and NO limit orders at mid±1¢ simultaneously. Size $10–$20 per order. Cancel if price moves > 8¢ from entry mid or if one side fills but not the other within 4 hours. Max 5 open LP positions at once.",
        },
      ]);
    }
    setLoading(false);
  }, []);

  // Load per-strategy performance stats from trades. Reads through the shared
  // React Query cache (same key as useSettledTrades) so this and every settled-
  // trades consumer share ONE network fetch instead of each scanning the table.
  const refreshStats = useCallback(async () => {
    const trades = await queryClient.fetchQuery({
      queryKey: tradesKeys.settled(),
      queryFn: fetchSettledTrades,
      staleTime: 30_000,
    });

    if (!trades) return;

    const statsMap: Record<string, StrategyStats> = {};
    const knownStrategyIds = new Set(strategies.map(s => s.id));
    const knownStrategyNames = new Set(strategies.map(s => s.name));

    for (const strat of strategies) {
      // Primary: match by strategy_id. Fallback for paper strategies only: match by
      // name for old trades recorded before strategy_id was required. Live strategies
      // only count exact strategy_id matches to prevent paper trades leaking in.
      const stratTrades = trades.filter(t =>
        t.strategy_id === strat.id ||
        (strat.mode !== "live" && !t.strategy_id && (t.strategy === strat.name || t.strategy === strat.id))
      );

      const totalPnl = stratTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const winningTrades = stratTrades.filter(t => (t.pnl || 0) > 0).length;
      const losingTrades = stratTrades.filter(t => (t.pnl || 0) < 0).length;
      const totalTrades = stratTrades.length;

      statsMap[strat.id] = {
        strategyId: strat.id,
        totalTrades,
        winningTrades,
        losingTrades,
        totalPnl: Math.round(totalPnl * 100) / 100,
        winRate: totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 100) : 0,
        roi: strat.starting_balance > 0 ? Math.round((totalPnl / strat.starting_balance) * 10000) / 100 : 0,
        balance: strat.starting_balance + totalPnl,
      };
    }

    // Capture trades that don't match any known strategy (pre-user_id-fix orphan trades).
    // These are real settled trades under this user's account but reference strategy IDs
    // from other test accounts. Surface them as "_unattributed" so totals reconcile.
    const orphanTrades = trades.filter(t =>
      !knownStrategyIds.has(t.strategy_id ?? "") &&
      !(t.strategy && (knownStrategyNames.has(t.strategy) || knownStrategyIds.has(t.strategy)))
    );
    if (orphanTrades.length > 0) {
      const totalPnl = orphanTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const winningTrades = orphanTrades.filter(t => (t.pnl || 0) > 0).length;
      const losingTrades = orphanTrades.filter(t => (t.pnl || 0) < 0).length;
      statsMap["_unattributed"] = {
        strategyId: "_unattributed",
        totalTrades: orphanTrades.length,
        winningTrades,
        losingTrades,
        totalPnl: Math.round(totalPnl * 100) / 100,
        winRate: orphanTrades.length > 0 ? Math.round((winningTrades / orphanTrades.length) * 100) : 0,
        roi: 0,
        balance: totalPnl,
      };
    }

    setStrategyStats(statsMap);
  }, [strategies, queryClient]);

  useEffect(() => {
    loadStrategies();
  }, [loadStrategies]);

  useEffect(() => {
    if (strategies.length > 0) {
      refreshStats();
    }
  }, [strategies, refreshStats]);

  // Debounced real-time updates to prevent race conditions on rapid changes
  const strategiesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tradesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single realtime channel for the whole dashboard. On a trades change it
  // debounces (500ms) then invalidates every ["trades", ...] query so all
  // consumers (positions, log, settled scan, stats) refresh from one place —
  // replacing the four separate per-component channels that used to each
  // re-fetch on every event. The winning-trade toast (moved here from TradeLog)
  // fires immediately on INSERT so it isn't delayed by the debounce.
  useEffect(() => {
    const channel = supabase
      .channel("strategies-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "strategies" }, () => {
        if (strategiesDebounce.current) clearTimeout(strategiesDebounce.current);
        strategiesDebounce.current = setTimeout(loadStrategies, 500);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, (payload) => {
        if (payload.eventType === "INSERT") {
          const t = payload.new as { pnl?: number | null; market_question?: string | null };
          if (t?.pnl != null && t.pnl > 0) {
            const q = t.market_question ?? "";
            toast.success(`+$${t.pnl.toFixed(2)} · ${q.substring(0, 40)}${q.length > 40 ? "…" : ""}`, { duration: 4000 });
          }
        }
        if (tradesDebounce.current) clearTimeout(tradesDebounce.current);
        tradesDebounce.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: tradesKeys.all });
          refreshStats();
        }, 500);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (strategiesDebounce.current) clearTimeout(strategiesDebounce.current);
      if (tradesDebounce.current) clearTimeout(tradesDebounce.current);
    };
  }, [loadStrategies, refreshStats, queryClient]);

  const updateStrategy = useCallback(async (id: string, updates: Partial<Strategy>) => {
    setStrategies(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

    const { error } = await supabase.from("strategies").update({
      ...updates,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) toast.error("Failed to save strategy change");
  }, []);

  const addStrategy = useCallback(async (strategy: Omit<Strategy, "id">) => {
    const id = generateStrategyId();
    const newStrat = { ...strategy, id };
    // Optimistic render, but ROLLED BACK on failure — the old version never
    // read the insert error, so a failed insert left a ghost card that
    // vanished on the next load with no explanation.
    setStrategies(prev => [...prev, newStrat]);

    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from("strategies").insert({
      id,
      // No template_id: a custom strategy has no template lineage until one is
      // assigned, which means auto-trade's dispatcher skips it and entitlement
      // fails closed for live — it exists as a draft, it cannot trade.
      name: strategy.name,
      description: strategy.description,
      instructions: strategy.instructions,
      active: strategy.active,
      mode: strategy.mode || "paper",
      starting_balance: strategy.starting_balance || 1000,
      user_id: session?.user?.id ?? null,
    });
    if (error) {
      setStrategies(prev => prev.filter(s => s.id !== id));
      toast.error(`Strategy not saved: ${error.message}`);
      return;
    }
    toast.success(`Strategy "${strategy.name}" saved.`);
  }, []);

  const deleteStrategy = useCallback(async (id: string) => {
    setStrategies(prev => prev.filter(s => s.id !== id));
    await supabase.from("strategies").delete().eq("id", id);
  }, []);

  const getActiveStrategies = useCallback(() => {
    return strategies.filter(s => s.active);
  }, [strategies]);

  const instanceExists = useMemo(() => {
    const map: Record<string, { paper: boolean; live: boolean }> = {};
    for (const s of strategies) {
      if (!s.template_id) continue;
      if (!map[s.template_id]) map[s.template_id] = { paper: false, live: false };
      map[s.template_id][s.mode] = true;
    }
    return map;
  }, [strategies]);

  return (
    <StrategiesContext.Provider value={{
      strategies, strategyStats, instanceExists, loading,
      updateStrategy, addStrategy, deleteStrategy, getActiveStrategies, refreshStats,
    }}>
      {children}
    </StrategiesContext.Provider>
  );
}

export function useStrategies() {
  const ctx = useContext(StrategiesContext);
  if (!ctx) throw new Error("useStrategies must be used within StrategiesProvider");
  return ctx;
}
