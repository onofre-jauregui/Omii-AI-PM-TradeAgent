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
  strategyFilter?: string | null;
  label?: string;
}

const MAY_START = "2026-04-22T00:00:00.000Z";
const FALLBACK_STARTING_BALANCE = 2_500;

export function PortfolioChart({
  mode,
  strategyFilter,
  label = "Portfolio Value",
}: PortfolioChartProps) {
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [startingBalance, setStartingBalance] = useState(FALLBACK_STARTING_BALANCE);
  const [loading, setLoading] = useState(true);

  const loadChartData = useCallback(async () => {
    setLoading(true);

    // Get starting balance from strategies table (same source as DashboardHero).
    // Must be mode-scoped: otherwise the live chart baselines at paper+live
    // combined (~$2,600) while its trades are live-only, so the value is wrong.
    let sbQuery = supabase.from("strategies").select("starting_balance, mode");
    if (mode) sbQuery = sbQuery.eq("mode", mode);
    const { data: strategyRows } = await sbQuery;

    const balance = strategyRows && strategyRows.length > 0
      ? strategyRows.reduce((s, r) => s + (r.starting_balance ?? 0), 0)
      : FALLBACK_STARTING_BALANCE;
    setStartingBalance(balance);

    // Query settled trades only — pnl is 0 on filled trades until Kalshi resolves
    let q = supabase
      .from("trades")
      .select("settled_at, pnl, mode, strategy")
      .eq("status", "settled")
      .gte("settled_at", MAY_START)
      .order("settled_at", { ascending: true });

    if (mode) q = q.eq("mode", mode);
    if (strategyFilter) q = q.eq("strategy", strategyFilter);

    const { data: trades } = await q;

    if (!trades || trades.length === 0) {
      setChartData([
        { date: "May 1", value: balance },
        { date: "Now", value: balance },
      ]);
      setLoading(false);
      return;
    }

    // Group P&L by day (settled_at date)
    const byDay: Record<string, number> = {};
    for (const t of trades) {
      const day = (t.settled_at ?? "").slice(0, 10);
      if (!day) continue;
      byDay[day] = (byDay[day] ?? 0) + (t.pnl ?? 0);
    }

    // Build cumulative portfolio value per day
    let cumulative = balance;
    const points: ChartPoint[] = [{ date: "Start", value: balance }];

    for (const day of Object.keys(byDay).sort()) {
      cumulative += byDay[day];
      const label = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      points.push({ date: label, value: Math.round(cumulative * 100) / 100 });
    }

    setChartData(points);
    setLoading(false);
  }, [mode, strategyFilter]);

  useEffect(() => {
    loadChartData();

    const channel = supabase
      .channel(`portfolio-chart-rt-${mode ?? "all"}-${strategyFilter ?? "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, loadChartData)
      .subscribe();

    const interval = setInterval(loadChartData, 30_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  // mode/strategyFilter are already implied by loadChartData's own deps (it's rebuilt
  // whenever either changes), listed explicitly here only to satisfy exhaustive-deps —
  // no new re-run case is introduced.
  }, [loadChartData, mode, strategyFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentValue = chartData.length > 0 ? chartData[chartData.length - 1].value : startingBalance;
  const totalReturn = startingBalance > 0
    ? (((currentValue - startingBalance) / startingBalance) * 100).toFixed(1)
    : "0.0";
  const isPositive = currentValue >= startingBalance;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-muted-foreground text-sm mb-1">{label}</p>
          <h1
            className="text-4xl sm:text-5xl font-light tracking-tight text-foreground"
            style={{ letterSpacing: "-0.03em" }}
          >
            ${currentValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-sm mb-1">Return</p>
          <p
            className={`text-2xl font-light ${isPositive ? "text-profit" : "text-loss"}`}
            style={{ letterSpacing: "-0.02em" }}
          >
            {isPositive ? "+" : ""}{totalReturn}%
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
              interval="preserveStartEnd"
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
              width={50}
              domain={["auto", "auto"]}
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
