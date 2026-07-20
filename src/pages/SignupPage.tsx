import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bot, Brain, Globe, Lock } from "lucide-react";

const FEATURES = [
  {
    Icon: Bot,
    title: "AI Agent, Always On",
    desc: "Scans Kalshi markets 24/7, qualifies setups, and executes trades while you sleep.",
  },
  {
    Icon: Brain,
    title: "Gets Smarter With Every Trade",
    desc: "Wins and losses feed back into shared memory. The model improves for every contributor.",
  },
  {
    Icon: Globe,
    title: "Community Edge",
    desc: "Opt in to the shared signal pool. More users → more trades → better returns for everyone.",
  },
  {
    Icon: Lock,
    title: "Your Keys, Your Capital",
    desc: "Connect your Kalshi API key. We never touch your funds — the agent trades on your behalf via Kalshi's own API.",
  },
];

const STATS = [
  { value: "$13B+", label: "Kalshi notional in March 2026" },
  { value: "25%", label: "Month-over-month volume growth" },
  { value: "Paper", label: "Trade mode — no real money until you're ready" },
];

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);

    const { error: dbErr } = await supabase
      .from("waitlist")
      .insert({ email: email.trim().toLowerCase() });

    setLoading(false);

    if (dbErr) {
      if (dbErr.code === "23505") {
        // unique violation — already on the list
        setSubmitted(true);
      } else {
        setError("Something went wrong. Try again.");
      }
      return;
    }

    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Nav */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <span className="font-semibold tracking-tight text-white">OMII Trade</span>
        <Badge variant="outline" className="text-xs border-white/20 text-white/60">
          Private Beta
        </Badge>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <Badge className="mb-6 bg-white/10 text-white/80 hover:bg-white/10 border-0 text-xs tracking-widest uppercase">
          Kalshi Prediction Markets
        </Badge>

        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight leading-tight max-w-3xl">
          An AI agent that trades
          <br />
          <span className="text-white/50">prediction markets for you.</span>
        </h1>

        <p className="mt-6 text-white/50 max-w-xl text-lg leading-relaxed">
          OMII Trade runs a 24/7 strategy engine on Kalshi. Every trade it makes teaches it something.
          Those lessons compound — for you and for every user who contributes to the shared signal pool.
        </p>

        {/* Stats row */}
        <div className="mt-12 flex flex-wrap justify-center gap-8">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-xs text-white/40 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Waitlist form */}
        <div className="mt-14 w-full max-w-md">
          {submitted ? (
            <div className="rounded-xl border border-white/10 bg-white/5 px-8 py-8">
              <div className="text-2xl mb-2">✓</div>
              <p className="text-white font-medium">You're on the list.</p>
              <p className="text-white/40 text-sm mt-1">
                We'll reach out when your spot opens.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
              <Input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-white/5 border-white/10 text-white placeholder:text-white/30 focus-visible:ring-white/20 flex-1"
              />
              <Button
                type="submit"
                disabled={loading}
                className="bg-white text-black hover:bg-white/90 font-semibold px-6 shrink-0"
              >
                {loading ? "Joining…" : "Join Waitlist"}
              </Button>
            </form>
          )}
          {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
          {!submitted && (
            <p className="text-white/30 text-xs mt-3">
              No spam. No pitch decks. Just an early access invite when we're ready.
            </p>
          )}
        </div>
      </main>

      {/* Features */}
      <section className="border-t border-white/10 px-6 py-20">
        <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-8">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex gap-4">
              <f.Icon className="h-5 w-5 mt-0.5 text-white/60 shrink-0" />
              <div>
                <h3 className="font-semibold text-white">{f.title}</h3>
                <p className="text-white/40 text-sm mt-1 leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-white/10 px-6 py-20 bg-white/[0.02]">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-12">How the flywheel works</h2>
          <div className="flex flex-col gap-6 text-left">
            {[
              ["Connect", "Link your Kalshi API key. The agent trades on your account."],
              ["Trade", "The strategy engine scans markets, qualifies setups, and executes."],
              ["Learn", "Every outcome — win or loss — writes a lesson to memory."],
              ["Share", "Opted-in users contribute lessons to the platform pool."],
              ["Compound", "Better shared memory → better signals → better returns for everyone."],
            ].map(([step, desc], i) => (
              <div key={step} className="flex gap-4 items-start">
                <div className="w-7 h-7 rounded-full border border-white/20 flex items-center justify-center text-xs text-white/50 shrink-0 mt-0.5">
                  {i + 1}
                </div>
                <div>
                  <span className="font-medium text-white">{step} — </span>
                  <span className="text-white/40 text-sm">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA footer */}
      <section className="border-t border-white/10 px-6 py-16 text-center">
        <p className="text-white/40 text-sm mb-4">
          Private beta. Limited spots. Kalshi US markets only.
        </p>
        {!submitted && (
          <Button
            onClick={() => document.querySelector("input[type=email]")?.scrollIntoView({ behavior: "smooth" })}
            variant="outline"
            className="border-white/20 text-white hover:bg-white/10"
          >
            Request access →
          </Button>
        )}
      </section>

      <footer className="border-t border-white/10 px-6 py-6 text-center text-white/20 text-xs">
        © {new Date().getFullYear()} OMII AI. Prediction markets involve risk. Not financial advice.
      </footer>
    </div>
  );
}
