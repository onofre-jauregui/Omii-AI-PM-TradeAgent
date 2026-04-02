import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
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
        { id: "S-001", name: "Momentum", description: "Buy when price trends upward with volume confirmation", instructions: "When analyzing markets, look for sustained directional price movement over the last 24-48 hours. Confirm with increasing volume. Enter positions when momentum is strong and exit when volume starts declining. Use a 5% trailing stop-loss. Favor markets with >$100K daily volume.", active: true, mode: "paper", starting_balance: 1000 },
        { id: "S-002", name: "Mean Reversion", description: "Trade against extreme price moves expecting reversion", instructions: "Identify markets where the YES/NO price has moved more than 15% in 24 hours without a clear fundamental catalyst. Take contrarian positions expecting prices to revert to the mean. Set take-profit at 50% of the deviation and stop-loss at 1.5x the deviation. Avoid markets near resolution dates.", active: false, mode: "paper", starting_balance: 1000 },
        { id: "S-003", name: "Cross-Market Arb", description: "Exploit price differences across correlated markets", instructions: "Look for correlated prediction markets where the combined probabilities create an arbitrage opportunity.", active: true, mode: "paper", starting_balance: 1000 },
        { id: "S-004", name: "AI Sentiment", description: "Use AI to analyze news & social sentiment for signals", instructions: "Analyze recent news headlines, social media sentiment, and expert opinions related to each market's underlying question. Score sentiment from -1 (very bearish) to +1 (very bullish). Trade when sentiment diverges from current market price by more than 20%.", active: false, mode: "paper", starting_balance: 1000 },
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
      // Match trades by strategy_id or by strategy name (backward compat)
      const stratTrades = trades.filter(
        t => t.strategy_id === strat.id || t.strategy === strat.name || t.strategy === strat.id
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

  // Real-time updates
  useEffect(() => {
    const channel = supabase
      .channel("strategies-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "strategies" }, () => {
        loadStrategies();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        refreshStats();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
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

    await supabase.from("strategies").insert({
      id,
      name: strategy.name,
      description: strategy.description,
      instructions: strategy.instructions,
      active: strategy.active,
      mode: strategy.mode || "paper",
      starting_balance: strategy.starting_balance || 1000,
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
