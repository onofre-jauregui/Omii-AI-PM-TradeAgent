import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ChartPoint {
  date: string;
  value: number;
}

const chartConfig = {
  value: {
    label: "Portfolio Value",
    color: "hsl(var(--primary))",
  },
};

interface PortfolioChartProps {
  mode?: "paper" | "live";
  startingBalance?: number;
  strategyFilter?: string | null; // strategy name to narrow by
  label?: string;
}

export function PortfolioChart({
  mode,
  startingBalance = 5000,
  strategyFilter,
  label = "Portfolio Value",
}: PortfolioChartProps) {
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const loadChartData = useCallback(async () => {
    setLoading(true);

    // May 1 2026 — same cutoff as DashboardHero, excludes pre-calibration trades
    const MAY_START = "2026-05-01T00:00:00.000Z";

    let q = supabase
      .from("trades")
      .select("created_at, amount, pnl, action, status, mode, strategy")
      .eq("status", "filled")
      .gte("created_at", MAY_START)
      .order("created_at", { ascending: true });

    if (mode) q = q.eq("mode", mode);
    if (strategyFilter) q = q.eq("strategy", strategyFilter);

    const { data: trades } = await q;

    if (trades && trades.length > 0) {
      let cumulativeValue = startingBalance;
      const points: ChartPoint[] = [{ date: "Start", value: startingBalance }];

      for (const trade of trades) {
        const pnl = trade.pnl || 0;
        if (trade.action === "buy") {
          cumulativeValue = cumulativeValue - trade.amount + pnl;
        } else {
          cumulativeValue = cumulativeValue + trade.amount + pnl;
        }
        points.push({
          date: new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          value: Math.round(cumulativeValue),
        });
      }

      setChartData(points);
    } else {
      setChartData([
        { date: "Start", value: startingBalance },
        { date: "Now", value: startingBalance },
      ]);
    }

    setLoading(false);
  }, [mode, startingBalance, strategyFilter]);

  useEffect(() => {
    loadChartData();

    // Refresh chart when any trade is inserted or updated
    const channel = supabase
      .channel(`portfolio-chart-rt-${mode ?? "all"}-${strategyFilter ?? "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, loadChartData)
      .subscribe();

    // Also poll every 30s as a fallback (pnl updates won't always fire realtime)
    const interval = setInterval(loadChartData, 30_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [loadChartData, mode, strategyFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentValue = chartData.length > 0 ? chartData[chartData.length - 1].value : startingBalance;
  const totalReturn = startingBalance > 0 ? (((currentValue - startingBalance) / startingBalance) * 100).toFixed(1) : "0.0";
  const isPositive = currentValue >= startingBalance;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-muted-foreground text-sm mb-1">{label}</p>
          <h1 className="text-4xl sm:text-5xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.03em' }}>
            ${currentValue.toLocaleString()}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-sm mb-1">Return</p>
          <p className={`text-2xl font-light ${isPositive ? 'text-profit' : 'text-loss'}`} style={{ letterSpacing: '-0.02em' }}>
            {isPositive ? '+' : ''}{totalReturn}%
          </p>
        </div>
      </div>
      <div className="rounded-2xl bg-card p-4 sm:p-6 apple-shadow">
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={chartData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`portfolioGradient-${mode ?? "all"}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
              width={50}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill={`url(#portfolioGradient-${mode ?? "all"})`}
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </div>
  );
}
