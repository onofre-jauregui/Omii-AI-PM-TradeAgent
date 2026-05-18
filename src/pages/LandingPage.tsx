import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Brain,
  TrendingUp,
  Shield,
  BarChart2,
  Zap,
  ArrowRight,
  Check,
  Bot,
  Activity,
  Lock,
  Loader2,
  Menu,
  X,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

// ── Scroll-reveal hook ────────────────────────────────────────────────────────
function useInView(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView };
}

// ── Fade-in wrapper ───────────────────────────────────────────────────────────
function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(24px)",
        transition: `opacity 0.7s cubic-bezier(0.25,0.1,0.25,1) ${delay}ms, transform 0.7s cubic-bezier(0.25,0.1,0.25,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── Hero dashboard mockup ─────────────────────────────────────────────────────

interface DailyCumulative {
  date: string;
  cumPnl: number;
}

interface RecentTrade {
  ticker: string;
  side: string;
  amount: number;
  pnl: number;
}

interface PlatformStats {
  totalPnl: number;
  winRate: number;
  tradeCount: number;
  startDate: string;
  dailyCumulative: DailyCumulative[];
  recentTrades: RecentTrade[];
}

// Fallback data used when fetch fails
const FALLBACK_STATS: PlatformStats = {
  totalPnl: 940.30,
  winRate: 81.3,
  tradeCount: 150,
  startDate: "2026-04-23",
  dailyCumulative: [
    { date: "2026-04-23", cumPnl: 130.92 },
    { date: "2026-04-24", cumPnl: 246.27 },
    { date: "2026-04-25", cumPnl: 306.56 },
    { date: "2026-04-27", cumPnl: 119.77 },
    { date: "2026-04-28", cumPnl: 133.85 },
    { date: "2026-05-05", cumPnl: 350.43 },
    { date: "2026-05-07", cumPnl: 272.68 },
    { date: "2026-05-08", cumPnl: 412.16 },
    { date: "2026-05-09", cumPnl: 396.12 },
    { date: "2026-05-11", cumPnl: 1085.89 },
    { date: "2026-05-12", cumPnl: 969.85 },
    { date: "2026-05-13", cumPnl: 1008.06 },
    { date: "2026-05-14", cumPnl: 953.30 },
    { date: "2026-05-16", cumPnl: 940.30 },
  ],
  recentTrades: [
    { ticker: "KXBTC-26MAY1619-B74000", side: "NO", amount: 50, pnl: -13.00 },
    { ticker: "KXBTC-26MAY1619-B72000", side: "YES", amount: 50, pnl: 38.21 },
    { ticker: "KXBTC-26MAY1619-B70000", side: "YES", amount: 50, pnl: -54.76 },
  ],
};

function buildChartPath(points: DailyCumulative[]): { fill: string; line: string } {
  if (points.length < 2) {
    return {
      fill: "M0,85 L800,85 L800,85 L0,85 Z",
      line: "M0,85 L800,85",
    };
  }

  const maxPnl = Math.max(...points.map((p) => p.cumPnl));
  const minPnl = Math.min(0, ...points.map((p) => p.cumPnl));
  const range = maxPnl - minPnl || 1;

  // Map cumPnl to Y coordinate (inverted: higher = smaller Y, 5px top padding)
  const toY = (pnl: number) => 85 - ((pnl - minPnl) / range) * 80;
  const toX = (i: number) => (i / (points.length - 1)) * 800;

  const coords = points.map((p, i) => ({ x: toX(i), y: toY(p.cumPnl) }));

  // Build smooth cubic bezier path
  let d = `M${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const cp1x = prev.x + (curr.x - prev.x) / 3;
    const cp2x = prev.x + (2 * (curr.x - prev.x)) / 3;
    const cp1y = prev.y + (curr.y - prev.y) / 3;
    const cp2y = prev.y + (2 * (curr.y - prev.y)) / 3;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${curr.x.toFixed(1)},${curr.y.toFixed(1)}`;
  }

  const lastCoord = coords[coords.length - 1];
  const fill = `${d} L${lastCoord.x.toFixed(1)},90 L0,90 Z`;
  return { fill, line: d };
}

function HeroDashboardMockup() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const STATS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/platform-stats`;
    fetch(STATS_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: PlatformStats) => {
        // Use live data only if we got meaningful results; otherwise fall back
        if (data && typeof data.totalPnl === "number") {
          setStats(data);
        } else {
          setStats(FALLBACK_STATS);
        }
      })
      .catch(() => setStats(FALLBACK_STATS))
      .finally(() => setLoading(false));
  }, []);

  const s = stats ?? FALLBACK_STATS;
  const portfolio = (2500 + s.totalPnl).toFixed(2);
  const { fill: chartFill, line: chartLine } = buildChartPath(s.dailyCumulative);

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: "16/9",
        maxWidth: 900,
        borderRadius: 24,
        background: "linear-gradient(160deg, #1a1a1a 0%, #0d0d0d 100%)",
        boxShadow: "0 40px 80px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full" style={{ background: "#ff5f57" }} />
          <div className="h-3 w-3 rounded-full" style={{ background: "#febc2e" }} />
          <div className="h-3 w-3 rounded-full" style={{ background: "#28c840" }} />
        </div>
        <span style={{ color: "#6e6e73", fontSize: 11, letterSpacing: "0.06em" }}>TradeAgent · Paper Mode</span>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full animate-pulse-gentle" style={{ background: "#34d058" }} />
          <span style={{ color: "#34d058", fontSize: 11 }}>Live</span>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "0 24px" }} />

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-0 px-6 pt-5">
        {loading ? (
          // Skeleton state
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-3 first:pl-0">
              <div className="h-2 w-14 rounded animate-pulse mb-2" style={{ background: "rgba(255,255,255,0.08)" }} />
              <div className="h-5 w-20 rounded animate-pulse mb-1" style={{ background: "rgba(255,255,255,0.10)" }} />
              <div className="h-2 w-16 rounded animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} />
            </div>
          ))
        ) : (
          [
            { label: "Portfolio", value: `$${portfolio}`, sub: "Paper balance", color: "#f5f5f7" },
            { label: `P&L Since ${s.startDate.slice(5).replace("-", "/")}`, value: `+$${s.totalPnl.toFixed(2)}`, sub: `+${((s.totalPnl / 2500) * 100).toFixed(1)}%`, color: "#34d058" },
            { label: "Win Rate", value: `${s.winRate.toFixed(1)}%`, sub: `${s.tradeCount} settled trades`, color: "#f5f5f7" },
            { label: "Agent Status", value: "Active", sub: "Auto-trading", color: "#34d058" },
          ].map((stat) => (
            <div key={stat.label} className="px-3 first:pl-0">
              <div style={{ color: "#6e6e73", fontSize: 10, letterSpacing: "0.05em", marginBottom: 4 }}>
                {stat.label.toUpperCase()}
              </div>
              <div style={{ color: stat.color, fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>
                {stat.value}
              </div>
              <div style={{ color: "#6e6e73", fontSize: 10, marginTop: 2 }}>{stat.sub}</div>
            </div>
          ))
        )}
      </div>

      {/* Chart area */}
      <div className="px-6 pt-5">
        <div style={{ height: 1, background: "rgba(255,255,255,0.04)", marginBottom: 12 }} />
        {loading ? (
          <div className="h-[90px] rounded animate-pulse" style={{ background: "rgba(255,255,255,0.05)" }} />
        ) : (
          <svg width="100%" height="90" viewBox="0 0 800 90" preserveAspectRatio="none">
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d058" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#34d058" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={chartFill} fill="url(#pnlGrad)" stroke="none" />
            <path d={chartLine} fill="none" stroke="#34d058" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </div>

      {/* Trade rows */}
      <div className="px-6 pt-2 pb-5 space-y-1.5">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.04)" }}>
              <div className="h-3 w-32 rounded animate-pulse" style={{ background: "rgba(255,255,255,0.08)" }} />
              <div className="h-3 w-16 rounded animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} />
            </div>
          ))
        ) : (
          s.recentTrades.map((t, i) => {
            // Strip everything after the first hyphen-separated segment that looks like a date/price suffix
            // e.g. KXBTC-26MAY1619-B74000 → KXBTC
            const series = t.ticker.split("-")[0] ?? t.ticker;
            const pnlColor = t.pnl >= 0 ? "#34d058" : "#ff453a";
            const pnlLabel = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
            return (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                <span style={{ color: "#f5f5f7", fontSize: 11 }}>{series}</span>
                <div className="flex items-center gap-3">
                  <span
                    style={{
                      color: "#6e6e73",
                      fontSize: 10,
                      background: "rgba(255,255,255,0.07)",
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    {t.side}
                  </span>
                  <span style={{ color: "#6e6e73", fontSize: 11 }}>${t.amount.toFixed(2)}</span>
                  <span
                    style={{
                      color: pnlColor,
                      fontSize: 11,
                      fontWeight: 600,
                      minWidth: 56,
                      textAlign: "right",
                    }}
                  >
                    {pnlLabel}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Subtle vignette overlay */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0"
        style={{
          height: 60,
          background: "linear-gradient(to bottom, transparent, rgba(13,13,13,0.6))",
        }}
      />
    </div>
  );
}

// ── Waitlist form ─────────────────────────────────────────────────────────────
function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    supabase.from("waitlist").select("id", { count: "exact", head: true }).then(({ count: c }) => {
      if (c !== null) setCount(c);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("loading");
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
      const resp = await fetch(`${supabaseUrl}/functions/v1/waitlist-signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const json = await resp.json();
      if (json.ok || resp.ok) {
        setStatus("success");
        setCount((c) => (c !== null ? c + 1 : 1));
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="sm:max-w-md sm:mx-auto rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-6 py-4 text-center">
        <p className="text-emerald-600 dark:text-emerald-400 font-medium text-sm">You're on the list. Check your inbox for a confirmation.</p>
        {count !== null && <p className="text-xs text-muted-foreground mt-1">{count} people waiting</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 items-center">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:max-w-md sm:mx-auto w-full">
        <Input
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="rounded-full border-border bg-white px-5 h-12 text-sm flex-1"
        />
        <Button
          type="submit"
          size="lg"
          disabled={status === "loading"}
          className="rounded-full px-7 gap-2 h-12 shrink-0"
          style={{ background: "#0071e3", color: "#fff", border: "none" }}
        >
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {status === "loading" ? "Joining…" : "Join waitlist"}
        </Button>
      </form>
      {status === "error" && (
        <p className="text-xs text-destructive">Something went wrong. Try again.</p>
      )}
      {count !== null && status === "idle" && (
        <p className="text-xs text-muted-foreground">{count} {count === 1 ? "person" : "people"} on the waitlist</p>
      )}
    </div>
  );
}

// ── FAQ accordion ─────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: "Do I need a Kalshi account to start?",
    a: "No. Paper trading mode works immediately — no Kalshi account, no API key, no credit card. The agent trades on live market prices using simulated funds.",
  },
  {
    q: "How is my API key protected?",
    a: "Your Kalshi API key is encrypted with AES-256 before storage. It is only used to execute trades on your behalf — never logged, never shared, never used for anything else. You can revoke it from Kalshi in one click, anytime.",
  },
  {
    q: "Can the agent withdraw my Kalshi funds?",
    a: "No. Kalshi API keys are scoped to trading only. Withdrawals require a separate authenticated action in the Kalshi app. We have no access to withdrawals, transfers, or account settings.",
  },
  {
    q: "What are the strategies?",
    a: "Currently two live strategies: bracket-sum arbitrage (S-001) and cross-market correlation (S-005). Both run with automatic 12-hour exit limits and per-trade size caps. More strategies are in development.",
  },
  {
    q: "When does live trading open?",
    a: "Live trading is in closed waitlist access. We're validating paper trading performance first. Join the waitlist and you'll be notified when your spot is ready.",
  },
];

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="divide-y" style={{ borderColor: "#d2d2d7" }}>
      {FAQ_ITEMS.map((item, i) => (
        <div key={i}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="flex w-full items-center justify-between py-5 text-left"
          >
            <span className="text-base font-medium" style={{ color: "#1d1d1f" }}>{item.q}</span>
            <ChevronDown
              className="h-5 w-5 shrink-0 ml-4 transition-transform duration-300"
              style={{
                color: "#6e6e73",
                transform: open === i ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
          </button>
          <div
            style={{
              maxHeight: open === i ? 200 : 0,
              overflow: "hidden",
              transition: "max-height 0.35s cubic-bezier(0.25,0.1,0.25,1)",
            }}
          >
            <p className="pb-5 text-base leading-relaxed" style={{ color: "#6e6e73" }}>
              {item.a}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Feature cards data ────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: Brain,
    title: "Shared memory pool",
    body: "Every trade teaches the network. The more users, the sharper the signal.",
  },
  {
    icon: Shield,
    title: "AES-256 encryption",
    body: "Your Kalshi key is encrypted at rest. We can't withdraw your funds. Revoke access instantly.",
  },
  {
    icon: BarChart2,
    title: "Three-tier risk controls",
    body: "Set total budget, per-strategy allocation, and per-trade max. The engine enforces all three.",
  },
  {
    icon: Activity,
    title: "Paper mode always available",
    body: "Simulate on live prices indefinitely. No real money until you choose to go live.",
  },
  {
    icon: Zap,
    title: "14 agent tools",
    body: "The agent can create strategies, scan markets, execute trades, and review its own performance — from a single chat.",
  },
  {
    icon: TrendingUp,
    title: "Real exchange, regulated",
    body: "Kalshi is CFTC-licensed. Every trade executes on a federally supervised venue.",
  },
];

// ── Pricing tiers ─────────────────────────────────────────────────────────────
const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "",
    badge: null,
    description: "Build your track record with zero risk.",
    features: [
      "Full paper trading dashboard",
      "All active strategies running",
      "Agent chat + memory",
      "Performance analytics",
      "Community memory (read)",
    ],
    cta: "Start free",
    ctaLink: "/login",
    highlight: false,
  },
  {
    name: "Starter",
    price: "$29",
    period: "/mo",
    badge: "Most popular",
    description: "Real money, controlled risk. The agent trades for you.",
    features: [
      "Everything in Free",
      "Live trading on Kalshi",
      "Set your own dollar limit",
      "Strategies run automatically",
      "Strategy logic is managed for you",
    ],
    cta: "Join waitlist",
    ctaLink: "#waitlist",
    highlight: true,
  },
  {
    name: "Pro",
    price: "$99",
    period: "/mo",
    badge: null,
    description: "Full control. See, edit, and build your own strategies.",
    features: [
      "Everything in Starter",
      "Full strategy library access",
      "Edit and create custom strategies",
      "Community intelligence pool",
      "Priority support + API access",
    ],
    cta: "Join waitlist",
    ctaLink: "#waitlist",
    highlight: false,
  },
];

// ── Main landing page ─────────────────────────────────────────────────────────
export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen" style={{ background: "#ffffff", color: "#1d1d1f" }}>

      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-50"
        style={{
          background: "rgba(255,255,255,0.8)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(0,0,0,0.1)",
          height: 44,
        }}
      >
        <div
          className="mx-auto flex items-center justify-between px-6"
          style={{ maxWidth: 980, height: 44 }}
        >
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{ width: 24, height: 24, background: "#0071e3" }}
            >
              <Bot style={{ width: 14, height: 14, color: "#fff" }} />
            </div>
            <span style={{ fontSize: 17, fontWeight: 500, color: "#1d1d1f", letterSpacing: "-0.01em" }}>
              TradeAgent
            </span>
          </div>

          {/* Center links */}
          <div className="hidden items-center gap-8 md:flex">
            {["How it works", "Features", "Pricing"].map((label) => (
              <a
                key={label}
                href={`#${label.toLowerCase().replace(/ /g, "-")}`}
                style={{ fontSize: 14, color: "#1d1d1f", textDecoration: "none", opacity: 0.8 }}
                onMouseEnter={(e) => ((e.target as HTMLElement).style.opacity = "1")}
                onMouseLeave={(e) => ((e.target as HTMLElement).style.opacity = "0.8")}
              >
                {label}
              </a>
            ))}
          </div>

          {/* Right actions */}
          <div className="hidden items-center gap-4 md:flex">
            <Link
              to="/login"
              style={{ fontSize: 14, color: "#0071e3", textDecoration: "none" }}
            >
              Sign in
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center"
              style={{
                background: "#0071e3",
                color: "#fff",
                borderRadius: 980,
                fontSize: 14,
                fontWeight: 400,
                padding: "7px 16px",
                textDecoration: "none",
                lineHeight: 1,
              }}
            >
              Get started
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            className="flex items-center justify-center md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            style={{ color: "#1d1d1f" }}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/* Mobile overlay */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-40 flex flex-col px-6 pt-16 pb-10 md:hidden"
            style={{ background: "rgba(255,255,255,0.97)", backdropFilter: "blur(20px)" }}
          >
            <div className="flex flex-col gap-8">
              {["How it works", "Features", "Pricing"].map((label) => (
                <a
                  key={label}
                  href={`#${label.toLowerCase().replace(/ /g, "-")}`}
                  onClick={() => setMobileMenuOpen(false)}
                  style={{ fontSize: 24, fontWeight: 500, color: "#1d1d1f", textDecoration: "none" }}
                >
                  {label}
                </a>
              ))}
            </div>
            <div className="mt-auto flex flex-col gap-3">
              <Link
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  textAlign: "center",
                  padding: "14px 0",
                  fontSize: 17,
                  color: "#0071e3",
                  textDecoration: "none",
                  border: "1px solid #0071e3",
                  borderRadius: 980,
                }}
              >
                Sign in
              </Link>
              <Link
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  textAlign: "center",
                  padding: "14px 0",
                  fontSize: 17,
                  color: "#fff",
                  textDecoration: "none",
                  background: "#0071e3",
                  borderRadius: 980,
                }}
              >
                Get started
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section
        className="relative overflow-hidden text-center"
        style={{ paddingTop: 120, paddingBottom: 80, paddingLeft: 24, paddingRight: 24 }}
      >
        {/* Radial glow */}
        <div
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2"
          style={{
            width: 900,
            height: 500,
            background: "radial-gradient(ellipse at center top, rgba(0,113,227,0.07) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto" style={{ maxWidth: 980 }}>
          {/* Eyebrow */}
          <div
            className="mb-8 inline-flex items-center gap-2"
            style={{
              background: "rgba(0,113,227,0.08)",
              border: "none",
              borderRadius: 980,
              padding: "5px 14px",
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "#0071e3",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Introducing TradeAgent
            </span>
          </div>

          {/* H1 */}
          <h1
            className="mx-auto"
            style={{
              fontSize: "clamp(48px, 7vw, 80px)",
              fontWeight: 600,
              color: "#1d1d1f",
              letterSpacing: "-0.05em",
              lineHeight: 1.05,
              maxWidth: 800,
              marginBottom: 28,
            }}
          >
            Trade Kalshi Effortlessly
            <br />
            Use AI
          </h1>

          {/* Subhead */}
          <p
            className="mx-auto"
            style={{
              fontSize: 21,
              fontWeight: 400,
              color: "#6e6e73",
              lineHeight: 1.6,
              maxWidth: 580,
              marginBottom: 40,
            }}
          >
            Set your budget. Pick your strategies. Our agent watches the markets,
            spots trades, and executes instantly — improving with every outcome.
          </p>

          {/* CTAs */}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center" style={{ marginBottom: 32 }}>
            <Link
              to="/login"
              className="inline-flex items-center gap-2"
              style={{
                background: "#0071e3",
                color: "#fff",
                borderRadius: 980,
                fontSize: 17,
                fontWeight: 400,
                padding: "16px 28px",
                textDecoration: "none",
              }}
            >
              Start free — paper mode
              <ArrowRight style={{ width: 16, height: 16 }} />
            </Link>
            <a
              href="#how-it-works"
              style={{
                color: "#0071e3",
                fontSize: 17,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              See how it works →
            </a>
          </div>

          {/* Trust pills */}
          <div className="flex flex-wrap items-center justify-center gap-3" style={{ marginBottom: 64 }}>
            {["Free to start", "No funds custody", "Paper mode by default"].map((label) => (
              <div
                key={label}
                className="inline-flex items-center gap-1.5"
                style={{
                  background: "#f5f5f7",
                  borderRadius: 980,
                  padding: "6px 12px",
                  fontSize: 13,
                  color: "#1d1d1f",
                }}
              >
                <Check style={{ width: 12, height: 12, color: "#0071e3" }} />
                {label}
              </div>
            ))}
          </div>

          {/* Product mockup */}
          <div className="flex justify-center">
            <HeroDashboardMockup />
          </div>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section style={{ background: "#f5f5f7", padding: "48px 24px" }}>
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          <div className="grid grid-cols-2 gap-8 text-center md:grid-cols-4">
            {[
              { value: "$13B+", label: "Kalshi Volume (Mar 2026)" },
              { value: "24/7", label: "Agent runtime" },
              { value: "14", label: "Agent tools" },
              { value: "AES-256", label: "Key encryption" },
            ].map((stat) => (
              <div key={stat.label}>
                <div
                  style={{
                    fontSize: 32,
                    fontWeight: 600,
                    color: "#1d1d1f",
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    marginBottom: 6,
                  }}
                >
                  {stat.value}
                </div>
                <div style={{ fontSize: 14, color: "#6e6e73" }}>{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section
        id="how-it-works"
        style={{ padding: "120px 24px" }}
      >
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          <Reveal className="text-center" style={{ marginBottom: 64 }}>
            <p
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "#6e6e73",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 16,
              }}
            >
              How it works
            </p>
            <h2
              style={{
                fontSize: "clamp(32px, 4vw, 48px)",
                fontWeight: 600,
                color: "#1d1d1f",
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
              }}
            >
              From setup to trading in minutes.
            </h2>
          </Reveal>

          <div className="grid gap-5 md:grid-cols-3">
            {[
              {
                n: "1",
                icon: Lock,
                title: "Connect your Kalshi account",
                body: "Add your API key. We encrypt it with AES-256. Paper mode works without it.",
              },
              {
                n: "2",
                icon: BarChart2,
                title: "Set your strategy and budget",
                body: "Choose from proven strategies. Allocate your budget. The agent respects your limits on every trade.",
              },
              {
                n: "3",
                icon: Zap,
                title: "Let the agent trade",
                body: "The system scans markets every few minutes, qualifies setups with an LLM, and executes — 24/7.",
              },
            ].map((step, i) => (
              <Reveal key={step.n} delay={i * 100}>
                <div
                  className="relative overflow-hidden"
                  style={{
                    background: "#ffffff",
                    borderRadius: 18,
                    padding: 32,
                    boxShadow: "2px 4px 12px rgba(0,0,0,0.08)",
                    height: "100%",
                  }}
                >
                  {/* Large ghost number */}
                  <div
                    className="pointer-events-none absolute right-4 top-2 select-none"
                    style={{
                      fontSize: 120,
                      fontWeight: 700,
                      color: "#f5f5f7",
                      lineHeight: 1,
                    }}
                  >
                    {step.n}
                  </div>
                  {/* Icon */}
                  <div
                    className="relative mb-5 flex items-center justify-center"
                    style={{
                      width: 48,
                      height: 48,
                      background: "#f5f5f7",
                      borderRadius: 12,
                    }}
                  >
                    <step.icon style={{ width: 22, height: 22, color: "#0071e3" }} />
                  </div>
                  <h3
                    style={{
                      fontSize: 19,
                      fontWeight: 600,
                      color: "#1d1d1f",
                      letterSpacing: "-0.02em",
                      marginBottom: 10,
                    }}
                  >
                    {step.title}
                  </h3>
                  <p style={{ fontSize: 15, color: "#6e6e73", lineHeight: 1.6 }}>{step.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Feature grid ── */}
      <section
        id="features"
        style={{ background: "#f5f5f7", padding: "120px 24px" }}
      >
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          <Reveal className="text-center" style={{ marginBottom: 64 }}>
            <h2
              style={{
                fontSize: "clamp(32px, 4vw, 48px)",
                fontWeight: 600,
                color: "#1d1d1f",
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
                marginBottom: 12,
              }}
            >
              Community intelligence. Real edge.
            </h2>
            <p style={{ fontSize: 19, color: "#6e6e73", maxWidth: 560, margin: "0 auto" }}>
              Built with the controls serious traders need and the automation everyone wants.
            </p>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 60}>
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: 18,
                    padding: 28,
                    boxShadow: "2px 4px 12px rgba(0,0,0,0.08)",
                    height: "100%",
                  }}
                >
                  <div
                    className="mb-4 flex items-center justify-center"
                    style={{
                      width: 48,
                      height: 48,
                      background: "#f5f5f7",
                      borderRadius: 12,
                    }}
                  >
                    <f.icon style={{ width: 22, height: 22, color: "#0071e3" }} />
                  </div>
                  <h3 style={{ fontSize: 17, fontWeight: 600, color: "#1d1d1f", marginBottom: 8 }}>
                    {f.title}
                  </h3>
                  <p style={{ fontSize: 15, color: "#6e6e73", lineHeight: 1.6 }}>{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" style={{ padding: "120px 24px" }}>
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          <Reveal className="text-center" style={{ marginBottom: 64 }}>
            <h2
              style={{
                fontSize: "clamp(32px, 4vw, 48px)",
                fontWeight: 600,
                color: "#1d1d1f",
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
                marginBottom: 12,
              }}
            >
              Simple pricing. No surprises.
            </h2>
            <p style={{ fontSize: 19, color: "#6e6e73" }}>
              Start free with paper trading. Upgrade when you're ready to go live.
            </p>
          </Reveal>

          <div className="grid gap-5 md:grid-cols-3">
            {TIERS.map((tier, i) => (
              <Reveal key={tier.name} delay={i * 80}>
                <div
                  className="relative flex flex-col"
                  style={{
                    background: "#ffffff",
                    borderRadius: 18,
                    padding: 32,
                    boxShadow: "2px 4px 12px rgba(0,0,0,0.08)",
                    border: tier.highlight ? "2px solid #0071e3" : "2px solid transparent",
                    height: "100%",
                  }}
                >
                  {tier.badge && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2"
                      style={{
                        top: -14,
                        background: "#0071e3",
                        color: "#fff",
                        borderRadius: 980,
                        padding: "4px 14px",
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tier.badge}
                    </div>
                  )}
                  <div style={{ marginBottom: 24 }}>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#6e6e73",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        marginBottom: 8,
                      }}
                    >
                      {tier.name}
                    </p>
                    <div className="flex items-baseline gap-1" style={{ marginBottom: 8 }}>
                      <span
                        style={{
                          fontSize: 40,
                          fontWeight: 600,
                          color: "#1d1d1f",
                          letterSpacing: "-0.03em",
                        }}
                      >
                        {tier.price}
                      </span>
                      <span style={{ fontSize: 15, color: "#6e6e73" }}>{tier.period}</span>
                    </div>
                    <p style={{ fontSize: 15, color: "#6e6e73", lineHeight: 1.5 }}>
                      {tier.description}
                    </p>
                  </div>

                  <ul className="flex-1 space-y-3" style={{ marginBottom: 28 }}>
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5">
                        <Check
                          style={{ width: 16, height: 16, color: "#0071e3", marginTop: 2, flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 15, color: "#6e6e73" }}>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <a
                    href={tier.ctaLink}
                    className="block text-center"
                    style={{
                      background: tier.highlight ? "#0071e3" : "transparent",
                      color: tier.highlight ? "#fff" : "#0071e3",
                      border: tier.highlight ? "none" : "1px solid #0071e3",
                      borderRadius: 980,
                      fontSize: 17,
                      fontWeight: 400,
                      padding: "12px 0",
                      textDecoration: "none",
                    }}
                  >
                    {tier.cta}
                  </a>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section style={{ background: "#f5f5f7", padding: "120px 24px" }}>
        <div className="mx-auto" style={{ maxWidth: 680 }}>
          <Reveal className="text-center" style={{ marginBottom: 64 }}>
            <h2
              style={{
                fontSize: "clamp(28px, 4vw, 48px)",
                fontWeight: 600,
                color: "#1d1d1f",
                letterSpacing: "-0.03em",
                lineHeight: 1.1,
              }}
            >
              Questions answered.
            </h2>
          </Reveal>
          <Reveal delay={100}>
            <FAQSection />
          </Reveal>
        </div>
      </section>

      {/* ── Final CTA / Waitlist ── */}
      <section
        id="waitlist"
        style={{ background: "#1d1d1f", padding: "120px 24px", textAlign: "center" }}
      >
        <div className="mx-auto" style={{ maxWidth: 680 }}>
          <Reveal>
            <div
              className="mb-6 inline-flex items-center gap-2"
              style={{
                background: "rgba(255,255,255,0.08)",
                borderRadius: 980,
                padding: "5px 14px",
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full animate-pulse-gentle"
                style={{ background: "#34d058" }}
              />
              <span style={{ fontSize: 12, color: "#f5f5f7", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Live trading opening soon
              </span>
            </div>

            <h2
              style={{
                fontSize: "clamp(36px, 5vw, 56px)",
                fontWeight: 600,
                color: "#f5f5f7",
                letterSpacing: "-0.04em",
                lineHeight: 1.05,
                marginBottom: 16,
              }}
            >
              Your agent is waiting.
            </h2>
            <p
              style={{
                fontSize: 19,
                color: "rgba(245,245,247,0.6)",
                marginBottom: 40,
                lineHeight: 1.5,
              }}
            >
              Paper mode is free, instant, and requires no Kalshi account to start.
            </p>

            <WaitlistForm />

            <p style={{ marginTop: 20, fontSize: 13, color: "rgba(245,245,247,0.35)" }}>
              No spam. Unsubscribe anytime.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ background: "#f5f5f7", padding: "80px 24px 40px" }}>
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4" style={{ marginBottom: 60 }}>
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
                <div
                  className="flex items-center justify-center rounded-lg"
                  style={{ width: 24, height: 24, background: "#0071e3" }}
                >
                  <Bot style={{ width: 14, height: 14, color: "#fff" }} />
                </div>
                <span style={{ fontSize: 15, fontWeight: 500, color: "#1d1d1f" }}>TradeAgent</span>
              </div>
              <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.6, maxWidth: 200 }}>
                AI-powered prediction market trading on Kalshi.
              </p>
            </div>

            {/* Product */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1d1d1f", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>
                Product
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { label: "Dashboard", to: "/login" },
                  { label: "Markets", to: "/login" },
                  { label: "Agent", to: "/login" },
                  { label: "Performance", to: "/performance" },
                ].map((l) => (
                  <Link
                    key={l.label}
                    to={l.to}
                    style={{ fontSize: 14, color: "#6e6e73", textDecoration: "none" }}
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>

            {/* Legal */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1d1d1f", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>
                Legal
              </p>
              <div className="flex flex-col gap-3">
                <Link to="/terms" style={{ fontSize: 14, color: "#6e6e73", textDecoration: "none" }}>Terms</Link>
                <Link to="/privacy" style={{ fontSize: 14, color: "#6e6e73", textDecoration: "none" }}>Privacy</Link>
              </div>
            </div>

            {/* Company */}
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#1d1d1f", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>
                Company
              </p>
              <div className="flex flex-col gap-3">
                <a href="mailto:omiiaiagency@gmail.com" style={{ fontSize: 14, color: "#6e6e73", textDecoration: "none" }}>Contact</a>
                <Link to="/login" style={{ fontSize: 14, color: "#6e6e73", textDecoration: "none" }}>Sign in</Link>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div
            className="flex flex-col items-center justify-between gap-3 sm:flex-row"
            style={{ borderTop: "1px solid #d2d2d7", paddingTop: 24 }}
          >
            <p style={{ fontSize: 13, color: "#6e6e73" }}>© 2026 Omii AI. All rights reserved.</p>
            <p style={{ fontSize: 13, color: "#6e6e73" }}>Not financial advice.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
