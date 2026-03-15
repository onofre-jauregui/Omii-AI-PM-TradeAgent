import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface Strategy {
  id: string;
  name: string;
  description: string;
  instructions: string;
  active: boolean;
}

const DEFAULT_STRATEGIES: Strategy[] = [
  {
    id: "momentum",
    name: "Momentum",
    description: "Buy when price trends upward with volume confirmation",
    instructions: "When analyzing markets, look for sustained directional price movement over the last 24-48 hours. Confirm with increasing volume. Enter positions when momentum is strong and exit when volume starts declining. Use a 5% trailing stop-loss. Favor markets with >$100K daily volume.",
    active: true,
  },
  {
    id: "mean-reversion",
    name: "Mean Reversion",
    description: "Trade against extreme price moves expecting reversion",
    instructions: "Identify markets where the YES/NO price has moved more than 15% in 24 hours without a clear fundamental catalyst. Take contrarian positions expecting prices to revert to the mean. Set take-profit at 50% of the deviation and stop-loss at 1.5x the deviation. Avoid markets near resolution dates.",
    active: false,
  },
  {
    id: "arbitrage",
    name: "Cross-Market Arb",
    description: "Exploit price differences across correlated markets",
    instructions: "Look for correlated prediction markets where the combined probabilities create an arbitrage opportunity. For example, if Market A (YES) + Market B (NO) costs less than $1 and the outcomes are mutually exclusive, buy both. Also look for YES + NO prices within the same market that don't sum to exactly $1.",
    active: true,
  },
  {
    id: "sentiment",
    name: "AI Sentiment",
    description: "Use AI to analyze news & social sentiment for signals",
    instructions: "Analyze recent news headlines, social media sentiment, and expert opinions related to each market's underlying question. Score sentiment from -1 (very bearish) to +1 (very bullish). Trade when sentiment diverges from current market price by more than 20%. Weight recent news more heavily than older information.",
    active: false,
  },
];

interface StrategiesContextType {
  strategies: Strategy[];
  updateStrategy: (id: string, updates: Partial<Strategy>) => void;
  addStrategy: (strategy: Omit<Strategy, "id">) => void;
  deleteStrategy: (id: string) => void;
  getActiveStrategies: () => Strategy[];
}

const StrategiesContext = createContext<StrategiesContextType | null>(null);

export function StrategiesProvider({ children }: { children: ReactNode }) {
  const [strategies, setStrategies] = useState<Strategy[]>(DEFAULT_STRATEGIES);

  const updateStrategy = useCallback((id: string, updates: Partial<Strategy>) => {
    setStrategies(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const addStrategy = useCallback((strategy: Omit<Strategy, "id">) => {
    const id = `custom-${Date.now()}`;
    setStrategies(prev => [...prev, { ...strategy, id }]);
  }, []);

  const deleteStrategy = useCallback((id: string) => {
    setStrategies(prev => prev.filter(s => s.id !== id));
  }, []);

  const getActiveStrategies = useCallback(() => {
    return strategies.filter(s => s.active);
  }, [strategies]);

  return (
    <StrategiesContext.Provider value={{ strategies, updateStrategy, addStrategy, deleteStrategy, getActiveStrategies }}>
      {children}
    </StrategiesContext.Provider>
  );
}

export function useStrategies() {
  const ctx = useContext(StrategiesContext);
  if (!ctx) throw new Error("useStrategies must be used within StrategiesProvider");
  return ctx;
}
