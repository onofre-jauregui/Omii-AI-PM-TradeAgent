import { TrendingUp, TrendingDown, DollarSign, BarChart3, Target, Clock } from "lucide-react";
import { MOCK_POSITIONS } from "@/lib/mockData";

export function PortfolioOverview() {
  const totalValue = MOCK_POSITIONS.reduce((s, p) => s + p.value, 0);
  const totalPnl = MOCK_POSITIONS.reduce((s, p) => s + p.pnl, 0);
  const pnlPercent = ((totalPnl / (totalValue - totalPnl)) * 100).toFixed(1);
  const winRate = 68;

  return (
    <div className="space-y-8 apple-reveal">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={DollarSign} label="Portfolio Value" value={`$${totalValue.toLocaleString()}`} />
        <StatCard
          icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="Total P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toLocaleString()}`}
          valueClass={totalPnl >= 0 ? "text-profit" : "text-loss"}
          sub={`${pnlPercent}%`}
        />
        <StatCard icon={Target} label="Win Rate" value={`${winRate}%`} valueClass="text-profit" />
        <StatCard icon={BarChart3} label="Open Positions" value={`${MOCK_POSITIONS.length}`} />
      </div>

      <div className="rounded-2xl bg-card apple-shadow">
        <div className="px-6 py-4">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Active Positions</h3>
          </div>
          <div className="space-y-1">
            {MOCK_POSITIONS.map((pos) => (
              <div key={pos.id} className="flex items-center justify-between py-4 border-b border-border last:border-0">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{pos.market}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {pos.side.toUpperCase()} @ {pos.entry}¢ → {pos.current}¢
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium tabular-nums ${pos.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">${pos.value.toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, valueClass = "text-foreground", sub }: {
  icon: React.ElementType; label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="rounded-2xl bg-card p-5 apple-shadow transition-shadow duration-300 hover:apple-shadow-hover">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-medium tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className={`text-sm ${valueClass} mt-0.5`}>{sub}</p>}
    </div>
  );
}
