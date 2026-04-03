import { FlaskConical } from "lucide-react";
import { PortfolioStats, PortfolioOverview } from "./PortfolioOverview";
import { AgentPanel } from "./AgentPanel";
import { TradeLog } from "./TradeLog";

export function DemoPanel() {
  return (
    <div className="space-y-8 apple-reveal">
      {/* Header banner */}
      <div className="rounded-2xl bg-primary/5 ring-1 ring-primary/20 px-6 py-4 flex items-start gap-3">
        <FlaskConical className="h-5 w-5 text-primary shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-foreground">Paper Trading Demo</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Trades here are fully simulated against live Kalshi market data. No real money changes hands.
            Your paper balance starts at $10,000 and tracks gains/losses as if they were real.
          </p>
        </div>
      </div>

      {/* Paper portfolio stats */}
      <PortfolioStats mode="paper" />

      {/* Agent locked to paper mode */}
      <AgentPanel forcePaperMode />

      {/* Paper trade log */}
      <TradeLog filterMode="paper" />

      {/* Paper positions */}
      <PortfolioOverview mode="paper" />
    </div>
  );
}
