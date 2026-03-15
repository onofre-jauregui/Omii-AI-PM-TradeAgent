import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { TrendingUp } from "lucide-react";

const chartData = [
  { date: "Jan 1", value: 5000, pnl: 0 },
  { date: "Jan 15", value: 5120, pnl: 120 },
  { date: "Feb 1", value: 5350, pnl: 350 },
  { date: "Feb 15", value: 5180, pnl: 180 },
  { date: "Mar 1", value: 5620, pnl: 620 },
  { date: "Mar 5", value: 5480, pnl: 480 },
  { date: "Mar 8", value: 5750, pnl: 750 },
  { date: "Mar 10", value: 5900, pnl: 900 },
  { date: "Mar 12", value: 5820, pnl: 820 },
  { date: "Mar 14", value: 6100, pnl: 1100 },
  { date: "Mar 15", value: 6220, pnl: 1220 },
];

const chartConfig = {
  value: {
    label: "Portfolio Value",
    color: "hsl(var(--primary))",
  },
};

export function PortfolioChart() {
  const currentValue = chartData[chartData.length - 1].value;
  const startValue = chartData[0].value;
  const totalReturn = (((currentValue - startValue) / startValue) * 100).toFixed(1);

  return (
    <Card className="bg-card border-border glow-primary">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> PORTFOLIO PERFORMANCE
          </CardTitle>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs font-mono text-muted-foreground">TOTAL VALUE</p>
              <p className="text-lg font-mono font-bold text-foreground">${currentValue.toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-mono text-muted-foreground">RETURN</p>
              <p className="text-lg font-mono font-bold text-profit">+{totalReturn}%</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ChartContainer config={chartConfig} className="h-[200px] w-full">
          <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <defs>
              <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontFamily: "JetBrains Mono" }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontFamily: "JetBrains Mono" }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
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
      </CardContent>
    </Card>
  );
}
