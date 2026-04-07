import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Line, LineChart, XAxis, YAxis, Legend } from "recharts";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Target, BarChart3, DollarSign, Activity, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useStrategies } from "@/lib/strategiesContext";

// Distinct colors for up to 34 strategies
const STRATEGY_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#6366f1",
  "#84cc16", "#e11d48", "#0ea5e9", "#d946ef", "#10b981",
  "#eab308", "#7c3aed", "#f43f5e", "#2dd4bf", "#a855f7",
  "#4ade80", "#fb923c", "#38bdf8", "#c084fc", "#34d399",
  "#fbbf24", "#818cf8", "#fb7185", "#67e8f9", "#a78bfa",
  "#86efac", "#fcd34d", "#93c5fd", "#f9a8d4",
];

interface PerStrategyPoint {
  date: string;
  [strategyId: string]: number | string;
}

export function StrategyPerformance({ mode }: { mode?: "paper" | "live" }) {
  const { strategies, strategyStats } = useStrategies();
  const [chartData, setChartData] = useState<PerStrategyPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const activeStrategies = strategies.filter(s =>
    (s.active || (strategyStats[s.id]?.totalTrades ?? 0) > 0) &&
    (!mode || s.mode === mode)
  );

  const buildChartData = useCallback(async () => {
    setLoading(true);

    // Fetch all filled trades with strategy info
    let q = supabase
      .from("trades")
      .select("strategy, strategy_id, pnl, amount, action, created_at, status, mode")
      .eq("status", "filled")
      .order("created_at", { ascending: true });
    if (mode) q = q.eq("mode", mode);
    const { data: trades } = await q;

    if (!trades || trades.length === 0) {
      setChartData([]);
      setLoading(false);
      return;
    }

    // Build per-strategy cumulative balance over time
    const stratBalances: Record<string, number> = {};
    for (const s of strategies) {
      stratBalances[s.id] = s.starting_balance;
    }

    // Group trades by day
    const dayMap = new Map<string, typeof trades>();
    for (const t of trades) {
      const day = new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day)!.push(t);
    }

    const points: PerStrategyPoint[] = [];

    // Start point
    const startPoint: PerStrategyPoint = { date: "Start" };
    for (const s of strategies) {
      startPoint[s.id] = s.starting_balance;
    }
    points.push(startPoint);

    // Process each day
    for (const [day, dayTrades] of dayMap) {
      for (const t of dayTrades) {
        // Primary: match by strategy_id. Fallback: name/id match for old trades without strategy_id.
        const matchedStrat = strategies.find(s =>
          t.strategy_id === s.id ||
          (!t.strategy_id && (t.strategy === s.name || t.strategy === s.id))
        );
        if (matchedStrat) {
          const pnl = t.pnl || 0;
          stratBalances[matchedStrat.id] += pnl;
          if (t.action === "buy") {
            stratBalances[matchedStrat.id] -= t.amount;
          } else {
            stratBalances[matchedStrat.id] += t.amount;
          }
        }
      }

      const point: PerStrategyPoint = { date: day };
      for (const s of strategies) {
        point[s.id] = Math.round(stratBalances[s.id]);
      }
      points.push(point);
    }

    setChartData(points);
    setLoading(false);
  }, [strategies]);

  useEffect(() => {
    if (strategies.length > 0) {
      buildChartData();
    }
  }, [strategies, buildChartData]);

  // Build chart config dynamically
  const chartConfig: Record<string, { label: string; color: string }> = {};
  activeStrategies.forEach((s, i) => {
    chartConfig[s.id] = {
      label: `${s.id} ${s.name}`,
      color: STRATEGY_COLORS[i % STRATEGY_COLORS.length],
    };
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Sort strategies by ROI for the leaderboard
  const sortedStrategies = [...activeStrategies].sort((a, b) => {
    const roiA = strategyStats[a.id]?.roi ?? 0;
    const roiB = strategyStats[b.id]?.roi ?? 0;
    return roiB - roiA;
  });

  return (
    <div className="space-y-6">
      {/* Strategy Performance Chart */}
      {chartData.length > 1 && (
        <div className="rounded-2xl bg-card p-6 apple-shadow">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Strategy Performance</h3>
            <span className="text-[10px] text-muted-foreground">({activeStrategies.length} strategies)</span>
          </div>
          <ChartContainer config={chartConfig} className="h-[250px] w-full">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
                width={50}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {activeStrategies.map((s, i) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  stroke={STRATEGY_COLORS[i % STRATEGY_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  name={`${s.id} ${s.name}`}
                />
              ))}
            </LineChart>
          </ChartContainer>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 mt-3">
            {activeStrategies.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: STRATEGY_COLORS[i % STRATEGY_COLORS.length] }}
                />
                <span className="text-[10px] text-muted-foreground">{s.id} {s.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strategy Leaderboard */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Strategy Leaderboard</h3>
          </div>
        </div>
        <div className="divide-y divide-border">
          {sortedStrategies.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No active strategies. Enable strategies in the Strategies tab.
            </p>
          ) : (
            sortedStrategies.map((strat, rank) => {
              const stats = strategyStats[strat.id];
              const pnl = stats?.totalPnl ?? 0;
              const roi = stats?.roi ?? 0;
              const balance = stats?.balance ?? strat.starting_balance;

              return (
                <div key={strat.id} className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/50 transition-colors">
                  <span className="text-lg font-light text-muted-foreground w-6 text-center tabular-nums">
                    {rank + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] rounded-full font-mono px-1.5">
                        {strat.id}
                      </Badge>
                      <p className="text-sm font-medium text-foreground truncate">{strat.name}</p>
                      <Badge variant="secondary" className={`text-[9px] rounded-full ${
                        strat.mode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"
                      }`}>
                        {strat.mode}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {stats?.totalTrades ?? 0} trades · {stats?.winningTrades ?? 0}W / {stats?.losingTrades ?? 0}L
                    </p>
                  </div>
                  <div className="grid grid-cols-4 gap-4 text-right">
                    <div>
                      <p className="text-[9px] text-muted-foreground">Balance</p>
                      <p className="text-xs font-medium tabular-nums">${Math.round(balance).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground">P&L</p>
                      <p className={`text-xs font-medium tabular-nums ${pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground">ROI</p>
                      <p className={`text-xs font-medium tabular-nums ${roi >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground">Win%</p>
                      <p className={`text-xs font-medium tabular-nums ${(stats?.winRate ?? 0) >= 50 ? 'text-profit' : 'text-loss'}`}>
                        {stats?.totalTrades ? `${stats.winRate}%` : '--'}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
