import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, Zap, Users, DollarSign, Server, Brain, BarChart3, ArrowUpRight } from "lucide-react";
import { PAID_TIERS, tierPriceLabel } from "@/lib/pricing";

// Break-even is quoted against the real published prices. This paragraph used to
// hardcode a $29 Starter and a $49 alternative — neither price has ever existed —
// which put a fabricated unit-economics number in front of the one reader who
// makes pricing decisions from it.
const ENTRY_PAID_TIER = PAID_TIERS[0];
const HIGHLIGHT_TIER = PAID_TIERS.find((t) => t.highlight) ?? PAID_TIERS[PAID_TIERS.length - 1];

// ─── Fixed infrastructure costs ───────────────────────────────────────────────
const INFRA = [
  { name: "Supabase Pro", monthly: 25, note: "DB + Edge Functions + pg_cron + Auth", tier: "infrastructure" },
  { name: "Vercel Pro", monthly: 20, note: "Frontend hosting + preview deployments", tier: "infrastructure" },
  { name: "NWS Weather API", monthly: 0, note: "NOAA forecast data — free, no limits", tier: "infrastructure" },
  { name: "Langfuse Cloud", monthly: 0, note: "LLM observability — free under 50K events/mo", tier: "infrastructure" },
  { name: "Kalshi API", monthly: 0, note: "Trading API — no fees, revenue from spreads", tier: "infrastructure" },
];

// ─── Edge function cron schedules ─────────────────────────────────────────────
const CRONS = [
  { name: "surface-scanner",  schedule: "Every 30s",  runsPerDay: 2880,  note: "Largest driver — global, 1 run regardless of user count" },
  { name: "auto-trade",       schedule: "Every 2 min", runsPerDay: 720,   note: "Runs per active user group (system + subscribers)" },
  { name: "auto-settle",      schedule: "Every 10 min", runsPerDay: 144,  note: "Global — resolves all open positions" },
  { name: "weather-signal",   schedule: "Every 10 min", runsPerDay: 144,  note: "Global — generates S-005 signals" },
  { name: "futures-signal",   schedule: "Every 10 min", runsPerDay: 144,  note: "Global — generates S-001 signals" },
  { name: "auto-reflect",     schedule: "Every 1 hr",  runsPerDay: 24,   note: "Global — memory + health monitor" },
  { name: "health-check",     schedule: "Every 1 hr",  runsPerDay: 24,   note: "Global — Telegram alerts" },
];

// LLM cost model: gpt-4o-mini via OpenRouter
const LLM_INPUT_PER_M  = 0.15;  // $/1M input tokens
const LLM_OUTPUT_PER_M = 0.60;  // $/1M output tokens
const QUALIFY_INPUT_TOKENS  = 1_200;
const QUALIFY_OUTPUT_TOKENS = 50;

function calcLLMCost(callsPerMonth: number): number {
  const inputCost  = (callsPerMonth * QUALIFY_INPUT_TOKENS  / 1_000_000) * LLM_INPUT_PER_M;
  const outputCost = (callsPerMonth * QUALIFY_OUTPUT_TOKENS / 1_000_000) * LLM_OUTPUT_PER_M;
  return inputCost + outputCost;
}

// Supabase free tier: 2M edge invocations/month
const SUPABASE_FREE_INVOCATIONS = 2_000_000;
const TOTAL_DAILY_INVOCATIONS = CRONS.reduce((s, c) => s + c.runsPerDay, 0);
const TOTAL_MONTHLY_INVOCATIONS = TOTAL_DAILY_INVOCATIONS * 30;

function fmt(n: number, decimals = 2): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(decimals)}`;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

interface LiveMetrics {
  totalUsers: number;
  tradesLast30d: number;
  settledLast30d: number;
  surfaceAlerts30d: number;
  waitlistCount: number;
  loading: boolean;
}

export default function CostReport() {
  const [live, setLive] = useState<LiveMetrics>({
    totalUsers: 0, tradesLast30d: 0, settledLast30d: 0,
    surfaceAlerts30d: 0, waitlistCount: 0, loading: true,
  });

  useEffect(() => {
    async function load() {
      const [profilesRes, tradesRes, alertsRes, waitlistRes] = await Promise.allSettled([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("trades").select("status").gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
        supabase.from("surface_alerts").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
        supabase.from("waitlist").select("id", { count: "exact", head: true }),
      ]);

      const trades = tradesRes.status === "fulfilled" ? (tradesRes.value.data ?? []) : [];
      setLive({
        totalUsers:       profilesRes.status === "fulfilled" ? (profilesRes.value.count ?? 0) : 0,
        tradesLast30d:    trades.length,
        settledLast30d:   trades.filter(t => t.status === "settled").length,
        surfaceAlerts30d: alertsRes.status === "fulfilled"   ? (alertsRes.value.count ?? 0)   : 0,
        waitlistCount:    waitlistRes.status === "fulfilled" ? (waitlistRes.value.count ?? 0)  : 0,
        loading: false,
      });
    }
    load();
  }, []);

  // LLM: not every strategy run triggers a qualify — S-001 arb has no LLM gate.
  // Estimate: ~60% of trades go through qualify (S-002 + S-005 only).
  const qualifyCallsPerMonth = Math.round(live.tradesLast30d * 1.5); // includes rejected setups
  const llmCostCurrent = calcLLMCost(qualifyCallsPerMonth);
  const infraTotal = INFRA.reduce((s, i) => s + i.monthly, 0);
  const totalMonthly = infraTotal + llmCostCurrent;

  // Scaling projections
  const SCALE_TIERS = [1, 10, 50, 100, 500];

  function projectedCost(users: number) {
    // LLM scales with users (each user's strategies generate qualify calls)
    const llm = calcLLMCost(qualifyCallsPerMonth * users);
    // Supabase: Pro covers 2M invocations. At scale, edge invocations grow with auto-trade runs.
    // surface-scanner is global (fixed). auto-trade adds ~720 runs/day per user group.
    const supabasePlan = users > 80 ? 25 + 25 : 25; // Team plan ~$50 at very high scale
    const vercel = users > 200 ? 20 : (users > 50 ? 20 : 20);
    return { llm, supabase: supabasePlan, vercel, total: llm + supabasePlan + vercel };
  }

  const invocationPct = ((TOTAL_MONTHLY_INVOCATIONS / SUPABASE_FREE_INVOCATIONS) * 100).toFixed(1);

  if (live.loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading cost report…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10 max-w-4xl mx-auto">

      {/* Header */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Cost Report</h1>
        </div>
        <p className="text-sm text-muted-foreground">OMII TradeAgent — Infrastructure & Operating Costs · Live data</p>
      </div>

      {/* Live snapshot */}
      <section className="mb-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Live Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Users",            value: live.totalUsers,       icon: Users },
            { label: "Waitlist",         value: live.waitlistCount,    icon: Users },
            { label: "Trades / 30d",     value: live.tradesLast30d,    icon: BarChart3 },
            { label: "Settled / 30d",    value: live.settledLast30d,   icon: TrendingUp },
            { label: "Surface alerts / 30d", value: fmtK(live.surfaceAlerts30d), icon: Zap, raw: true },
          ].map(({ label, value, icon: Icon, raw }) => (
            <div key={label} className="rounded-xl bg-card border border-border p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
              </div>
              <p className="text-xl font-semibold tabular-nums">{raw ? value : value.toLocaleString()}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Monthly cost summary */}
      <section className="mb-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Monthly Cost — Current ({live.totalUsers} user{live.totalUsers !== 1 ? "s" : ""})</h2>
        <div className="rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Service</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Cost/mo</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody>
              {INFRA.map((item, i) => (
                <tr key={item.name} className={`border-b border-border ${i === INFRA.length - 1 ? "border-b-0" : ""}`}>
                  <td className="px-5 py-3 font-medium">{item.name}</td>
                  <td className="px-5 py-3 tabular-nums text-foreground">
                    {item.monthly === 0
                      ? <span className="text-profit text-xs font-semibold">Free</span>
                      : <span className="font-semibold">{fmt(item.monthly, 0)}</span>}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground text-xs hidden md:table-cell">{item.note}</td>
                </tr>
              ))}
              <tr className="border-b border-border bg-muted/20">
                <td className="px-5 py-3 font-medium">LLM Qualify Calls</td>
                <td className="px-5 py-3 tabular-nums font-semibold">
                  {llmCostCurrent < 0.01
                    ? <span className="text-profit text-xs font-semibold">&lt;$0.01</span>
                    : fmt(llmCostCurrent)}
                </td>
                <td className="px-5 py-3 text-muted-foreground text-xs hidden md:table-cell">
                  gpt-4o-mini via OpenRouter · ~{qualifyCallsPerMonth} calls/mo · $0.15/1M input tokens
                </td>
              </tr>
              <tr className="bg-primary/5 font-semibold">
                <td className="px-5 py-3 text-foreground">Total</td>
                <td className="px-5 py-3 text-foreground tabular-nums text-base">{fmt(totalMonthly, 2)}</td>
                <td className="px-5 py-3 text-muted-foreground text-xs hidden md:table-cell">
                  {fmt(totalMonthly / Math.max(live.totalUsers, 1), 2)}/user/month
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Edge function invocations */}
      <section className="mb-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Edge Function Invocations</h2>
        <div className="rounded-2xl border border-border overflow-hidden mb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Function</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Schedule</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Runs/mo</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody>
              {CRONS.map((c, i) => (
                <tr key={c.name} className={`border-b border-border ${i === CRONS.length - 1 ? "border-b-0" : ""}`}>
                  <td className="px-5 py-3 font-mono text-xs font-medium">{c.name}</td>
                  <td className="px-5 py-3 text-muted-foreground text-xs">{c.schedule}</td>
                  <td className="px-5 py-3 tabular-nums text-right">{fmtK(c.runsPerDay * 30)}</td>
                  <td className="px-5 py-3 text-muted-foreground text-xs hidden md:table-cell">{c.note}</td>
                </tr>
              ))}
              <tr className="bg-muted/20 font-semibold border-t border-border">
                <td className="px-5 py-3">Total</td>
                <td className="px-5 py-3" />
                <td className="px-5 py-3 tabular-nums text-right">{fmtK(TOTAL_MONTHLY_INVOCATIONS)}</td>
                <td className="px-5 py-3 text-xs text-muted-foreground hidden md:table-cell">
                  {invocationPct}% of Supabase Pro 2M free tier
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="rounded-xl bg-muted/30 border border-border px-5 py-3 flex items-start gap-3">
          <Zap className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">surface-scanner runs every 30s</span> — the dominant cost driver at {fmtK(2880 * 30)} invocations/month.
            Dropping to every 2 minutes would reduce total invocations to ~{fmtK((TOTAL_MONTHLY_INVOCATIONS - 2880 * 30 + 720 * 30))} and give
            {" "}5× headroom for user growth before hitting Supabase limits.
          </p>
        </div>
      </section>

      {/* Scaling projections */}
      <section className="mb-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Scaling Projections</h2>
        <div className="rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Users</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Supabase</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Vercel</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">LLM</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Total/mo</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground">Per user</th>
              </tr>
            </thead>
            <tbody>
              {SCALE_TIERS.map((users, i) => {
                const p = projectedCost(users);
                const perUser = p.total / users;
                const isCurrent = users === 1;
                return (
                  <tr key={users} className={`border-b border-border last:border-b-0 ${isCurrent ? "bg-primary/5" : ""}`}>
                    <td className="px-5 py-3 font-semibold">
                      {users.toLocaleString()}
                      {isCurrent && <span className="ml-2 text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">now</span>}
                    </td>
                    <td className="px-5 py-3 tabular-nums text-right">{fmt(p.supabase, 0)}</td>
                    <td className="px-5 py-3 tabular-nums text-right">{fmt(p.vercel, 0)}</td>
                    <td className="px-5 py-3 tabular-nums text-right">{p.llm < 0.01 ? "<$0.01" : fmt(p.llm)}</td>
                    <td className="px-5 py-3 tabular-nums font-semibold text-right">{fmt(p.total, 0)}</td>
                    <td className="px-5 py-3 tabular-nums text-right text-muted-foreground">
                      {perUser < 0.10 ? "<$0.10" : fmt(perUser)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2 px-1">
          LLM scales linearly with users. Infrastructure (Supabase + Vercel) is nearly fixed — same plan covers 1–100 users.
        </p>
      </section>

      {/* Unit economics */}
      <section className="mb-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Unit Economics</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              label: "Break-even MRR per user",
              value: fmt(totalMonthly / Math.max(live.totalUsers, 1)),
              sub: "at current user count",
              color: "text-foreground",
            },
            {
              label: "Cost per user at 100 users",
              value: fmt(projectedCost(100).total / 100),
              sub: "infrastructure amortized",
              color: "text-profit",
            },
            {
              label: "LLM cost per trade",
              value: live.tradesLast30d > 0
                ? `$${(llmCostCurrent / live.tradesLast30d).toFixed(4)}`
                : "—",
              sub: "gpt-4o-mini, qualify call",
              color: "text-profit",
            },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="rounded-2xl bg-card border border-border p-5">
              <p className="text-xs text-muted-foreground mb-2">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Key insight */}
      <section>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <ArrowUpRight className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div>
              <h3 className="font-semibold text-sm mb-2">Bottom Line</h3>
              <div className="space-y-1.5 text-sm text-muted-foreground leading-relaxed">
                <p>The cost structure is <span className="text-foreground font-medium">fixed-dominant</span> — {fmt(infraTotal, 0)}/mo in infrastructure covers the first ~100 users with no increase. LLM at gpt-4o-mini pricing is essentially negligible.</p>
                <p>At the <span className="text-foreground font-medium">{tierPriceLabel(ENTRY_PAID_TIER)}/mo {ENTRY_PAID_TIER.name} plan</span>, you break even at {Math.ceil(totalMonthly / ENTRY_PAID_TIER.monthlyPriceUsd)} paying {Math.ceil(totalMonthly / ENTRY_PAID_TIER.monthlyPriceUsd) === 1 ? "user" : "users"}; at {tierPriceLabel(HIGHLIGHT_TIER)}/mo {HIGHLIGHT_TIER.name}, {Math.ceil(totalMonthly / HIGHLIGHT_TIER.monthlyPriceUsd)}.</p>
                <p>The only scaling risk is surface-scanner invocations. Moving from 30s → 2min intervals frees enough headroom for 500+ users with zero additional infrastructure cost.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <p className="text-center text-xs text-muted-foreground mt-8">
        OMII TradeAgent · Admin Cost Report · Data as of {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
      </p>
    </div>
  );
}
