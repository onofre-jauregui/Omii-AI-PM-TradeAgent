import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface Strategy {
  id: string;
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
  loading: boolean;
  updateStrategy: (id: string, updates: Partial<Strategy>) => void;
  addStrategy: (strategy: Omit<Strategy, "id">) => void;
  deleteStrategy: (id: string) => void;
  getActiveStrategies: () => Strategy[];
  refreshStats: () => Promise<void>;
}

const StrategiesContext = createContext<StrategiesContextType | null>(null);

function generateStrategyId(existing: Strategy[]): string {
  // Find the next available number
  const numbers = existing
    .map(s => {
      const match = s.id.match(/^S-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter(n => n > 0);
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `S-${String(next).padStart(3, "0")}`;
}

export function StrategiesProvider({ children }: { children: ReactNode }) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyStats, setStrategyStats] = useState<Record<string, StrategyStats>>({});
  const [loading, setLoading] = useState(true);

  // Load strategies from DB
  const loadStrategies = useCallback(async () => {
    const { data, error } = await supabase
      .from("strategies")
      .select("*")
      .order("created_at", { ascending: true });

    if (!error && data) {
      setStrategies(data.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        active: s.active,
        mode: s.mode as "paper" | "live",
        starting_balance: s.starting_balance,
      })));
    } else {
      // Fallback defaults if DB not ready
      setStrategies([
        {
          id: "S-001", name: "Surface Arbitrage", mode: "paper", starting_balance: 1000, active: true,
          description: "Exploit structural price inconsistencies between related Kalshi markets — monotonicity violations, bracket sum gaps, and spread anomalies detected by the surface scanner.",
          instructions: "Always start by calling scan_surface. Prioritize monotonicity violations (lower threshold priced cheaper than higher threshold — near-riskless arb). Then bracket sum violations where sum of YES < 85¢. Then spread anomalies — post limit orders at the mid. Size $15–$50 depending on alert type. Do not trade alerts with confidence < 0.3.",
        },
        {
          id: "S-002", name: "Resolution Fade", mode: "paper", starting_balance: 1000, active: true,
          description: "Fade overreaction price moves in markets 2–7 days from resolution. Prediction market participants systematically overreact to recent news near expiry.",
          instructions: "Use fetch_signals filtered to time_value_score >= 0.7 and edge_score >= 0.4. For each candidate, judge: was the price move caused by a confirmed fundamental (skip) or sentiment/rumor (fade)? Fade sentiment-driven extremes with $20–$40 limit orders. Exit when price reverts 10¢ toward prior range. Hard stop if price moves 10¢ further against you.",
        },
        {
          id: "S-003", name: "Economic Consensus", mode: "paper", starting_balance: 1000, active: true,
          description: "Trade KXFED, KXCPI, KXPAYROLLS, KXGDP toward analyst consensus when Kalshi prices diverge from professional forecasts by more than 15¢.",
          instructions: "Focus on KXFED, KXCPI, KXPAYROLLS, KXGDP, KXCHCUTS series. For each market, reason from your training data and saved memories about the current professional consensus forecast. When Kalshi mid price diverges from consensus-implied probability by >= 15¢, trade toward consensus. Size $30–$75. Never hold through the data release unless conviction is high.",
        },
        {
          id: "S-004", name: "Liquidity Provision", mode: "paper", starting_balance: 1000, active: false,
          description: "Post limit orders near the mid on liquid, range-bound markets to passively collect the bid-ask spread. Low directional risk.",
          instructions: "Use fetch_signals to find markets with liquidity_score >= 0.5, spread >= 6¢, mid between 30¢–70¢, and no catalyst within 48h. Post YES and NO limit orders at mid±1¢ simultaneously. Size $10–$20 per order. Cancel if price moves > 8¢ from entry mid or if one side fills but not the other within 4 hours. Max 5 open LP positions at once.",
        },
      ]);
    }
    setLoading(false);
  }, []);

  // Load per-strategy performance stats from trades
  const refreshStats = useCallback(async () => {
    const { data: trades } = await supabase
      .from("trades")
      .select("strategy, strategy_id, pnl, status, amount")
      .eq("status", "filled");

    if (!trades) return;

    const statsMap: Record<string, StrategyStats> = {};

    for (const strat of strategies) {
      // Primary: match by strategy_id. Fallback: match by strategy name/id only for
      // old trades that were recorded before strategy_id was a required field.
      const stratTrades = trades.filter(t =>
        t.strategy_id === strat.id ||
        (!t.strategy_id && (t.strategy === strat.name || t.strategy === strat.id))
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

    setStrategyStats(statsMap);
  }, [strategies]);

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

  useEffect(() => {
    const channel = supabase
      .channel("strategies-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "strategies" }, () => {
        if (strategiesDebounce.current) clearTimeout(strategiesDebounce.current);
        strategiesDebounce.current = setTimeout(loadStrategies, 500);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        if (tradesDebounce.current) clearTimeout(tradesDebounce.current);
        tradesDebounce.current = setTimeout(refreshStats, 500);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (strategiesDebounce.current) clearTimeout(strategiesDebounce.current);
      if (tradesDebounce.current) clearTimeout(tradesDebounce.current);
    };
  }, [loadStrategies, refreshStats]);

  const updateStrategy = useCallback(async (id: string, updates: Partial<Strategy>) => {
    setStrategies(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));

    await supabase.from("strategies").update({
      ...updates,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
  }, []);

  const addStrategy = useCallback(async (strategy: Omit<Strategy, "id">) => {
    const id = generateStrategyId(strategies);
    const newStrat = { ...strategy, id };
    setStrategies(prev => [...prev, newStrat]);

    const { data: { session } } = await supabase.auth.getSession();
    await supabase.from("strategies").insert({
      id,
      name: strategy.name,
      description: strategy.description,
      instructions: strategy.instructions,
      active: strategy.active,
      mode: strategy.mode || "paper",
      starting_balance: strategy.starting_balance || 1000,
      user_id: session?.user?.id ?? null,
    });
  }, [strategies]);

  const deleteStrategy = useCallback(async (id: string) => {
    setStrategies(prev => prev.filter(s => s.id !== id));
    await supabase.from("strategies").delete().eq("id", id);
  }, []);

  const getActiveStrategies = useCallback(() => {
    return strategies.filter(s => s.active);
  }, [strategies]);

  return (
    <StrategiesContext.Provider value={{
      strategies, strategyStats, loading,
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
