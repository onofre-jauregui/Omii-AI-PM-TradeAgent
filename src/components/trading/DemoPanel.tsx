import { useState, useEffect } from "react";
import { FlaskConical, DollarSign, Pencil, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PortfolioStats, PortfolioOverview } from "./PortfolioOverview";
import { PortfolioChart } from "./PortfolioChart";
import { AgentPanel } from "./AgentPanel";
import { TradeLog } from "./TradeLog";
import { StrategyPerformance } from "./StrategyPerformance";
import { useStrategies } from "@/lib/strategiesContext";

const STORAGE_KEY = "demo_paper_balance";
const DEFAULT_BALANCE = 10_000;

export function DemoPanel() {
  const { strategies } = useStrategies();
  const paperStrategies = strategies.filter(s => s.mode === "paper" || s.active);

  // Editable paper starting balance (persisted in localStorage)
  const [balance, setBalance] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : DEFAULT_BALANCE;
  });
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState(String(balance));

  // Strategy filter for the chart
  const [selectedStrategy, setSelectedStrategy] = useState<string>("all");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(balance));
  }, [balance]);

  const commitBalance = () => {
    const parsed = parseFloat(balanceDraft.replace(/,/g, ""));
    if (!isNaN(parsed) && parsed > 0) {
      setBalance(parsed);
    } else {
      setBalanceDraft(String(balance));
    }
    setEditingBalance(false);
  };

  const strategyFilterValue = selectedStrategy === "all" ? null : selectedStrategy;

  return (
    <div className="space-y-8 apple-reveal">
      {/* Config bar — balance + strategy filter */}
      <div className="rounded-2xl bg-primary/5 ring-1 ring-primary/20 px-6 py-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-medium text-foreground">Paper Trading Demo</span>
            <Badge variant="secondary" className="text-[10px] rounded-full bg-primary/10 text-primary">
              Simulated · Real market data
            </Badge>
          </div>

          <div className="ml-auto flex items-center gap-3 flex-wrap">
            {/* Starting balance editor */}
            <div className="flex items-center gap-2">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Starting balance:</span>
              {editingBalance ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={balanceDraft}
                    onChange={e => setBalanceDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") commitBalance();
                      if (e.key === "Escape") { setBalanceDraft(String(balance)); setEditingBalance(false); }
                    }}
                    className="h-7 w-28 text-xs rounded-lg border-border bg-card px-2"
                    autoFocus
                  />
                  <button onClick={commitBalance} className="text-profit hover:opacity-70 transition-opacity">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => { setBalanceDraft(String(balance)); setEditingBalance(false); }}
                    className="text-muted-foreground hover:text-foreground transition-colors">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setBalanceDraft(String(balance)); setEditingBalance(true); }}
                  className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary transition-colors group"
                >
                  ${balance.toLocaleString()}
                  <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                </button>
              )}
            </div>

            {/* Strategy filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Strategy:</span>
              <Select value={selectedStrategy} onValueChange={setSelectedStrategy}>
                <SelectTrigger className="h-7 w-40 text-xs rounded-lg border-border bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All strategies</SelectItem>
                  {paperStrategies.map(s => (
                    <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>

      {/* Paper portfolio stats */}
      <PortfolioStats mode="paper" startingBalance={balance} />

      {/* Paper portfolio chart */}
      <PortfolioChart
        mode="paper"
        startingBalance={balance}
        strategyFilter={strategyFilterValue}
        label="Paper Balance"
      />

      {/* Strategy performance (paper trades) */}
      <StrategyPerformance mode="paper" />

      {/* Agent locked to paper mode */}
      <AgentPanel forcePaperMode />

      {/* Paper trade log */}
      <TradeLog filterMode="paper" />

      {/* Paper open positions */}
      <PortfolioOverview mode="paper" />
    </div>
  );
}
