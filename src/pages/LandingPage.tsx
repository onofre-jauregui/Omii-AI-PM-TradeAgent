import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Brain,
  TrendingUp,
  Users,
  Shield,
  BarChart2,
  Zap,
  ArrowRight,
  Check,
  Bot,
  Activity,
  ChevronRight,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

// ── Animated counter hook ─────────────────────────────────────────────────────
function useCounter(target: number, duration = 1800, trigger = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!trigger) return;
    let startTime: number | null = null;
    const step = (ts: number) => {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration, trigger]);
  return value;
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
        transform: inView ? "translateY(0)" : "translateY(20px)",
        transition: `opacity 0.6s cubic-bezier(0.25,0.1,0.25,1) ${delay}ms, transform 0.6s cubic-bezier(0.25,0.1,0.25,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── Live trade ticker ─────────────────────────────────────────────────────────
const MOCK_TRADES = [
  { market: "Fed rate cut by Dec?", side: "YES", size: "$240", result: "+$88" },
  { market: "S&P 500 above 5400?", side: "NO", size: "$180", result: "+$126" },
  { market: "BTC above $70k EOD?", side: "YES", size: "$95", result: "+$41" },
  { market: "CPI < 3% in May?", side: "YES", size: "$320", result: "+$210" },
  { market: "US recession by Q3?", side: "NO", size: "$500", result: "+$355" },
];

function TradeTicker() {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIdx((i) => (i + 1) % MOCK_TRADES.length);
        setVisible(true);
      }, 300);
    }, 2800);
    return () => clearInterval(id);
  }, []);

  const trade = MOCK_TRADES[idx];
  return (
    <div
      className="inline-flex items-center gap-3 rounded-full border border-border bg-card px-4 py-2 text-xs apple-shadow"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 0.3s ease" }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-profit animate-pulse-gentle" />
      <span className="text-muted-foreground">Agent just closed</span>
      <span className="text-foreground font-medium">{trade.market}</span>
      <span className="rounded bg-secondary px-1.5 py-0.5 text-foreground/70">
        {trade.side}
      </span>
      <span className="font-semibold text-profit">{trade.result}</span>
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function StatsBar() {
  const { ref, inView } = useInView();
  const notional = useCounter(13, 1600, inView);
  const growth = useCounter(1100, 1800, inView);
  const markets = useCounter(3200, 1400, inView);

  return (
    <div ref={ref} className="border-y border-border bg-secondary/50 py-10">
      <div className="mx-auto max-w-5xl px-6">
        <p className="text-center text-[11px] uppercase tracking-widest text-muted-foreground/60 mb-8">
          Kalshi · CFTC-regulated prediction market exchange
        </p>
        <div className="grid grid-cols-3 gap-8 text-center">
          <div>
            <div className="text-3xl font-semibold text-foreground">${notional}B+</div>
            <div className="mt-1 text-sm text-muted-foreground">Notional traded in March 2026</div>
          </div>
          <div>
            <div className="text-3xl font-semibold text-foreground">{growth}%</div>
            <div className="mt-1 text-sm text-muted-foreground">YoY volume growth</div>
          </div>
          <div>
            <div className="text-3xl font-semibold text-foreground">{markets.toLocaleString()}+</div>
            <div className="mt-1 text-sm text-muted-foreground">Active markets scanned daily</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── How it works steps ────────────────────────────────────────────────────────
const STEPS = [
  {
    number: "01",
    icon: Shield,
    title: "Connect your Kalshi account",
    body: "Paste your Kalshi API key. Takes 60 seconds. Start in paper mode — no real money, no pressure.",
  },
  {
    number: "02",
    icon: Bot,
    title: "AI takes the wheel",
    body: "TradeAgent scans every active market, ranks opportunities by confidence, and executes your strategy 24/7 — while you sleep.",
  },
  {
    number: "03",
    icon: Brain,
    title: "Every trade makes it smarter",
    body: "Wins, losses, near-misses — every outcome is reflected back into the model. Your intelligence feeds the platform. The platform feeds yours.",
  },
];

// ── Features ──────────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: Activity,
    title: "Real-time market scanning",
    body: "Every Kalshi market, every hour. No opportunity slips past.",
  },
  {
    icon: Shield,
    title: "Strategy health monitor",
    body: "Auto-suspends after drawdown thresholds. Resumes when the model stabilizes. Protects capital without you lifting a finger.",
  },
  {
    icon: BarChart2,
    title: "Paper trading mode",
    body: "Test any strategy on live markets with zero risk. Go live when you're ready — not when you're nervous.",
  },
  {
    icon: Brain,
    title: "Agent memory",
    body: "Lessons accumulate across every session. The agent that runs today is smarter than the one that ran yesterday.",
  },
  {
    icon: TrendingUp,
    title: "Multi-strategy engine",
    body: "Conservative, balanced, or aggressive. Switch modes in a click. Each strategy has its own risk envelope.",
  },
  {
    icon: Users,
    title: "Community intelligence",
    body: "Opt in to share learnings with the platform pool. Everyone who contributes benefits from collective signal.",
  },
];

// ── Trust signals ─────────────────────────────────────────────────────────────
const TRUST = [
  {
    icon: Lock,
    title: "Funds never leave Kalshi",
    body: "We trade on your behalf using your API key. We cannot withdraw funds or move money. Revoke access from Kalshi in one click, anytime.",
  },
  {
    icon: Shield,
    title: "AES-256 encrypted keys",
    body: "Your API key is encrypted at rest and never logged. Only used to execute your trades — never shared with any third party.",
  },
  {
    icon: TrendingUp,
    title: "You control the risk",
    body: "Set position limits, drawdown thresholds, and strategy aggression. The agent enforces your rules, always.",
  },
  {
    icon: Users,
    title: "CFTC-regulated venue",
    body: "Kalshi is the only CFTC-licensed prediction market exchange in the US. Every trade executes on a federally supervised venue.",
  },
];

// ── Flywheel diagram ──────────────────────────────────────────────────────────
const FLYWHEEL_NODES = [
  { label: "More Users", angle: 270 },
  { label: "More Trades", angle: 342 },
  { label: "More Outcomes", angle: 54 },
  { label: "Smarter Memory", angle: 126 },
  { label: "Better Edge", angle: 198 },
];

function FlywheelDiagram() {
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRotation((r) => r + 0.4), 30);
    return () => clearInterval(id);
  }, []);

  const R = 110;
  const cx = 160;
  const cy = 160;

  return (
    <div className="relative flex items-center justify-center">
      <svg width={320} height={320} viewBox="0 0 320 320" className="overflow-visible">
        {/* Outer ring */}
        <circle
          cx={cx} cy={cy} r={R}
          fill="none"
          stroke="hsl(var(--primary) / 0.2)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          style={{ transform: `rotate(${rotation}deg)`, transformOrigin: `${cx}px ${cy}px` }}
        />
        {/* Inner glow */}
        <circle
          cx={cx} cy={cy} r={52}
          fill="hsl(var(--primary) / 0.06)"
          stroke="hsl(var(--primary) / 0.3)"
          strokeWidth={1}
        />
        {/* Center label */}
        <text x={cx} y={cy - 7} textAnchor="middle" fill="hsl(var(--primary))" fontSize={11} fontWeight={600}>
          COLLECTIVE
        </text>
        <text x={cx} y={cy + 9} textAnchor="middle" fill="hsl(var(--primary))" fontSize={11} fontWeight={600}>
          INTELLIGENCE
        </text>

        {/* Nodes */}
        {FLYWHEEL_NODES.map(({ label, angle }) => {
          const rad = (angle * Math.PI) / 180;
          const nx = cx + R * Math.cos(rad);
          const ny = cy + R * Math.sin(rad);
          return (
            <g key={label}>
              <circle cx={nx} cy={ny} r={30}
                fill="hsl(var(--card))"
                stroke="hsl(var(--primary) / 0.35)"
                strokeWidth={1}
              />
              <text x={nx} y={ny - 2} textAnchor="middle"
                fill="hsl(var(--card-foreground))"
                fontSize={8.5} fontWeight={500}
              >
                {label.split(" ").map((word, i) => (
                  <tspan key={i} x={nx} dy={i === 0 ? 0 : 11}>{word}</tspan>
                ))}
              </text>
            </g>
          );
        })}

        {/* Arrows between nodes */}
        {FLYWHEEL_NODES.map(({ angle }, i) => {
          const nextAngle = FLYWHEEL_NODES[(i + 1) % FLYWHEEL_NODES.length].angle;
          const midAngle = ((angle + nextAngle) / 2) * (Math.PI / 180);
          const arrowR = R + 18;
          const ax = cx + arrowR * Math.cos(midAngle);
          const ay = cy + arrowR * Math.sin(midAngle);
          return (
            <text key={i} x={ax} y={ay} textAnchor="middle"
              fill="hsl(var(--primary) / 0.5)"
              fontSize={10}
            >
              →
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ── Main landing page ─────────────────────────────────────────────────────────
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Navbar ── */}
      <nav className="frosted-glass sticky top-0 z-50 border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Bot className="h-[18px] w-[18px] text-primary-foreground" />
            </div>
            <span className="text-[15px] font-semibold tracking-tight text-foreground">
              TradeAgent
            </span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#how-it-works" className="hidden text-sm text-muted-foreground hover:text-foreground transition-colors sm:block">
              How it works
            </a>
            <a href="#features" className="hidden text-sm text-muted-foreground hover:text-foreground transition-colors sm:block">
              Features
            </a>
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground hover:text-foreground">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button size="sm" asChild className="rounded-full px-5">
              <Link to="/login">Start free</Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden px-6 pb-24 pt-28 text-center">
        {/* Subtle primary glow */}
        <div
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2"
          style={{
            width: 800,
            height: 500,
            background: "radial-gradient(ellipse at center top, hsl(var(--primary) / 0.1) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-4xl">
          {/* Live badge */}
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-gentle" />
            Now live on Kalshi · Paper and live trading available
          </div>

          {/* Headline */}
          <h1 className="mb-6 text-5xl font-bold leading-[1.08] tracking-tight text-foreground sm:text-6xl lg:text-7xl"
            style={{ letterSpacing: "-0.03em" }}
          >
            The more we trade
            <br />
            <span className="text-primary">
              together, the smarter
              <br />
              it gets.
            </span>
          </h1>

          <p className="mx-auto mb-10 max-w-xl text-lg leading-relaxed text-muted-foreground">
            TradeAgent scans Kalshi prediction markets 24/7, executes on your
            behalf, and feeds every outcome into a shared intelligence layer.
            Your wins make everyone sharper. Everyone's wins make you sharper.
          </p>

          {/* CTAs */}
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Button size="lg" asChild className="rounded-full px-8 gap-2 shadow-lg">
              <Link to="/login">
                Start trading free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="rounded-full px-8 gap-2">
              <a href="#how-it-works">See how it works</a>
            </Button>
          </div>

          {/* Live trade ticker */}
          <div className="mt-12 flex justify-center">
            <TradeTicker />
          </div>

          {/* Trust line */}
          <p className="mt-5 text-xs text-muted-foreground/60">
            No credit card required · Your funds never leave Kalshi · AES-256 encrypted keys
          </p>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <StatsBar />

      {/* ── How it works ── */}
      <section id="how-it-works" className="px-6 py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="text-center mb-16">
            <p className="mb-3 text-[11px] uppercase tracking-widest text-primary">
              How it works
            </p>
            <h2 className="text-4xl font-bold tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>
              Three steps to hands-free alpha
            </h2>
          </Reveal>

          <div className="grid gap-5 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <Reveal key={step.number} delay={i * 100}>
                <div className="rounded-2xl border border-border bg-card p-8 apple-shadow hover:border-primary/20 transition-all duration-200">
                  <span className="mb-6 block font-mono text-[11px] font-bold tracking-widest text-primary/50">
                    {step.number}
                  </span>
                  <step.icon className="mb-4 h-5 w-5 text-primary" />
                  <h3 className="mb-3 text-base font-semibold text-foreground">
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Flywheel (the moat) ── */}
      <section className="px-6 py-24 border-y border-border bg-secondary/30">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-16 md:grid-cols-2 md:items-center">
            <Reveal>
              <p className="mb-3 text-[11px] uppercase tracking-widest text-primary">
                The moat
              </p>
              <h2 className="mb-6 text-4xl font-bold tracking-tight text-foreground leading-tight" style={{ letterSpacing: "-0.02em" }}>
                A trading edge that
                <br />
                compounds as it grows.
              </h2>
              <p className="mb-6 text-muted-foreground leading-relaxed">
                Most trading tools are static. You get the same software
                every other user gets. TradeAgent is different — the platform
                memory compounds with every trade ever executed by the community.
              </p>
              <p className="mb-8 text-muted-foreground leading-relaxed">
                High-confidence lessons graduate to the shared pool. Every
                opted-in user benefits. Every trade you make sharpens the
                signal for everyone — and everyone's signal sharpens yours.
              </p>
              <ul className="space-y-3 mb-6">
                {[
                  "Solo operators can't replicate a collective feedback loop",
                  "Closed-source competitors don't improve from user outcomes",
                  "The edge scales — not degrades — as the community grows",
                ].map((point) => (
                  <li key={point} className="flex items-start gap-3">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-profit" />
                    <span className="text-sm text-muted-foreground">{point}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground/60">
                Your trade outcomes are anonymized before contributing to the shared model. No personal data or exact position sizes are shared. You can opt out at any time from your account settings — opted-out users trade in isolation without receiving platform memory updates.
              </p>
            </Reveal>

            <Reveal delay={150}>
              <FlywheelDiagram />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="px-6 py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="text-center mb-16">
            <p className="mb-3 text-[11px] uppercase tracking-widest text-primary">
              Features
            </p>
            <h2 className="text-4xl font-bold tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>
              Everything your edge needs
            </h2>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 60}>
                <div className="rounded-2xl border border-border bg-card p-6 apple-shadow hover:border-primary/20 transition-all duration-200">
                  <div className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                    <f.icon className="h-4.5 w-4.5 text-primary" style={{ width: 18, height: 18 }} />
                  </div>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Trust signals ── */}
      <section className="border-y border-border bg-secondary/30 px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <Reveal className="text-center mb-12">
            <p className="mb-3 text-[11px] uppercase tracking-widest text-primary">
              Built to trust
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>
              Your keys. Your funds. Your rules.
            </h2>
          </Reveal>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((item, i) => (
              <Reveal key={item.title} delay={i * 80}>
                <div className="rounded-2xl border border-border bg-card p-5 apple-shadow text-center">
                  <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <item.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">{item.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative overflow-hidden px-6 py-36 text-center">
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: 700,
            height: 400,
            background: "radial-gradient(ellipse at center, hsl(var(--primary) / 0.08) 0%, transparent 70%)",
          }}
        />
        <Reveal className="relative mx-auto max-w-2xl">
          <h2 className="mb-4 text-5xl font-bold tracking-tight text-foreground" style={{ letterSpacing: "-0.03em" }}>
            Trade smarter.
            <br />
            <span className="text-primary">Starting today.</span>
          </h2>
          <p className="mb-10 text-lg text-muted-foreground">
            Free to start. No credit card. Switch to live trading when your
            paper record earns your confidence.
          </p>
          <Button size="lg" asChild className="rounded-full px-10 gap-2 shadow-xl">
            <Link to="/login">
              Get started free
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </Reveal>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border px-6 py-10">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
                <Bot className="h-3.5 w-3.5 text-primary-foreground" />
              </div>
              <span className="text-sm font-medium text-muted-foreground">TradeAgent</span>
            </div>
            <div className={cn("flex items-center gap-5 text-xs text-muted-foreground/60")}>
              <Link to="/performance" className="hover:text-foreground transition-colors">Performance</Link>
              <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
              <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
              <Link to="/login" className="hover:text-foreground transition-colors">Sign in</Link>
            </div>
          </div>
          <p className="mt-6 text-xs text-muted-foreground/40 text-center">
            For informational and educational purposes only. Not financial advice.
            All trading involves risk. Past performance is not indicative of future results.
          </p>
        </div>
      </footer>
    </div>
  );
}
