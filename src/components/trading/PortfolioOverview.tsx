import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, DollarSign, BarChart3, Target, Clock } from "lucide-react";
import { MOCK_POSITIONS } from "@/lib/mockData";

export function PortfolioOverview() {
  const totalValue = MOCK_POSITIONS.reduce((s, p) => s + p.value, 0);
  const totalPnl = MOCK_POSITIONS.reduce((s, p) => s + p.pnl, 0);
  const pnlPercent = ((totalPnl / (totalValue - totalPnl)) * 100).toFixed(1);
  const winRate = 68;

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={DollarSign} label="PORTFOLIO VALUE" value={`$${totalValue.toLocaleString()}`} />
        <StatCard
          icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
          label="TOTAL P&L"
          value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toLocaleString()}`}
          valueClass={totalPnl >= 0 ? "text-profit" : "text-loss"}
          sub={`${pnlPercent}%`}
        />
        <StatCard icon={Target} label="WIN RATE" value={`${winRate}%`} valueClass="text-profit" />
        <StatCard icon={BarChart3} label="OPEN POSITIONS" value={`${MOCK_POSITIONS.length}`} />
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" /> ACTIVE POSITIONS
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {MOCK_POSITIONS.map((pos) => (
              <div key={pos.id} className="flex items-center justify-between p-3 rounded-md bg-secondary/50 border border-border">
                <div className="flex-1">
                  <p className="text-sm font-medium">{pos.market}</p>
                  <p className="text-xs font-mono text-muted-foreground">
                    {pos.side.toUpperCase()} @ {pos.entry}¢ → {pos.current}¢
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-mono font-semibold ${pos.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">${pos.value.toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, valueClass = "text-foreground", sub }: {
  icon: React.ElementType; label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <Card className="bg-card border-border glow-primary">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-[10px] font-mono text-muted-foreground tracking-wider">{label}</span>
        </div>
        <p className={`text-xl font-mono font-bold ${valueClass}`}>{value}</p>
        {sub && <p className={`text-xs font-mono ${valueClass}`}>{sub}</p>}
      </CardContent>
    </Card>
  );
}
