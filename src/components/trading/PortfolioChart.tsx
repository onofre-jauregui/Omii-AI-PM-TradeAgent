import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { TrendingUp } from "lucide-react";

const chartData = [
  { date: "Jan 1", value: 5000 },
  { date: "Jan 15", value: 5120 },
  { date: "Feb 1", value: 5350 },
  { date: "Feb 15", value: 5180 },
  { date: "Mar 1", value: 5620 },
  { date: "Mar 5", value: 5480 },
  { date: "Mar 8", value: 5750 },
  { date: "Mar 10", value: 5900 },
  { date: "Mar 12", value: 5820 },
  { date: "Mar 14", value: 6100 },
  { date: "Mar 15", value: 6220 },
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
          <p className="text-2xl font-light text-profit" style={{ letterSpacing: '-0.02em' }}>
            +{totalReturn}%
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
