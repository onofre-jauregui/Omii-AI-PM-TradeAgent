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

export function PortfolioChart() {
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const loadChartData = useCallback(async () => {
    setLoading(true);

    // Fetch all filled trades ordered by date to build a cumulative P&L chart
    const { data: trades } = await supabase
      .from("trades")
      .select("created_at, amount, pnl, action, status")
      .eq("status", "filled")
      .order("created_at", { ascending: true });

    if (trades && trades.length > 0) {
      const startingBalance = 5000; // Assumed starting balance
      let cumulativeValue = startingBalance;
      const points: ChartPoint[] = [{ date: "Start", value: startingBalance }];

      for (const trade of trades) {
        const pnl = trade.pnl || 0;
        cumulativeValue += pnl;
        // Subtract cost for buys, add for sells
        if (trade.action === "buy") {
          cumulativeValue -= trade.amount;
        } else {
          cumulativeValue += trade.amount;
        }
        points.push({
          date: new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          value: Math.round(cumulativeValue),
        });
      }

      setChartData(points);
    } else {
      // No trades yet, show flat line at starting balance
      setChartData([
        { date: "Start", value: 5000 },
        { date: "Now", value: 5000 },
      ]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    loadChartData();
  }, [loadChartData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentValue = chartData.length > 0 ? chartData[chartData.length - 1].value : 0;
  const startValue = chartData.length > 0 ? chartData[0].value : 0;
  const totalReturn = startValue > 0 ? (((currentValue - startValue) / startValue) * 100).toFixed(1) : "0.0";
  const isPositive = currentValue >= startValue;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-muted-foreground text-sm mb-1">Portfolio Value</p>
          <h1 className="text-5xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.03em' }}>
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
      <div className="rounded-2xl bg-card p-6 apple-shadow">
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={chartData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
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
              fill="url(#portfolioGradient)"
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </div>
  );
}
