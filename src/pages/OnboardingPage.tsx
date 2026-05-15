import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, Loader2, AlertCircle, ArrowRight, Zap } from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const KALSHI_PING_URL = `${SUPABASE_URL}/functions/v1/kalshi-ping`;
const SAVE_KEY_URL = `${SUPABASE_URL}/functions/v1/save-kalshi-key`;

type Step = "welcome" | "connect" | "mode" | "live";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [chosenMode, setChosenMode] = useState<"paper" | "live">("paper");

  async function finishOnboarding(destination: string, mode?: "paper" | "live") {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("profiles")
        .upsert(
          { id: user.id, onboarding_completed: true, ...(mode ? { trading_mode: mode } : {}) },
          { onConflict: "id" }
        );

      // Seed all three starter strategies. Idempotent — safe to re-run.
      const tradeMode = mode ?? "paper";
      await supabase.from("strategies").upsert(
        [
          {
            id: "S-001",
            name: "Surface Arbitrage",
            description: "Exploits bracket-sum mispricing in KXINX/KXBTC/KXETH markets.",
            instructions: "Read surface_alerts for bracket_sum_violation. Buy NO on the most overpriced YES legs (yesAsk descending). Max 3 legs per event at $15/leg. Mark alert is_exploited after fill. No LLM gate — structural edge.",
            active: true,
            mode: tradeMode,
            starting_balance: 500,
            user_id: user.id,
          },
          {
            id: "S-002",
            name: "Resolution Fade",
            description: "Fade overreaction price moves in markets 2–7 days from resolution.",
            instructions: "Use fetch_signals filtered to time_value_score >= 0.7 and edge_score >= 0.4. Fade sentiment-driven extremes with $20–$40 limit orders. Exit when price reverts 10¢ toward prior range.",
            active: true,
            mode: tradeMode,
            starting_balance: 1000,
            user_id: user.id,
          },
          {
            id: "S-005",
            name: "Weather Edge",
            description: "Trades NWS forecast vs Kalshi implied temperature divergence.",
            instructions: "Compare NWS probability-of-precipitation and temperature forecasts to Kalshi Weather markets. Trade when divergence exceeds 15¢. Size $15–$30.",
            active: true,
            mode: tradeMode,
            starting_balance: 1000,
            user_id: user.id,
          },
        ],
        { onConflict: "id" }
      );
    }
    navigate(destination);
  }

  function chooseModeAndContinue(mode: "paper" | "live") {
    setChosenMode(mode);
    if (mode === "live") {
      finishOnboarding("/billing", "live");
    } else {
      setStep("live");
    }
  }

  // Kalshi key fields
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pingStatus, setPingStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [pingError, setPingError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  async function saveKalshiKey(): Promise<boolean> {
    if (!keyId.trim() || !privateKey.trim()) return false;
    setSaving(true);
    setSaveStatus("idle");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(SAVE_KEY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key_id: keyId.trim(), private_key: privateKey.trim() }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error ?? "Save failed");
      setSaveStatus("saved");
      return true;
    } catch {
      setSaveStatus("error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (saveStatus !== "saved") {
      const ok = await saveKalshiKey();
      if (!ok) return;
    }
    setPingStatus("testing");
    setPingError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(KALSHI_PING_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const json = await resp.json();
      if (json.ok) {
        setPingStatus("ok");
        setBalance(json.balance_usd ?? null);
      } else {
        setPingStatus("fail");
        setPingError(json.error ?? "Connection failed");
      }
    } catch (e) {
      setPingStatus("fail");
      setPingError(e instanceof Error ? e.message : "Connection failed");
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        {/* Progress dots */}
        <div className="flex gap-1.5 mb-10 justify-center">
          {(["welcome", "connect", "mode", "live"] as Step[]).map((s) => (
            <div key={s} className={`h-1.5 rounded-full transition-all ${step === s ? "w-6 bg-foreground" : "w-1.5 bg-muted"}`} />
          ))}
        </div>

        {/* ── Step 1: Welcome ─────────────────────────────────────── */}
        {step === "welcome" && (
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight mb-3">You're in.</h1>
            <p className="text-muted-foreground leading-relaxed mb-10">
              OMII Trade is an AI agent that watches Kalshi prediction markets 24/7 and places trades on your behalf. Start with paper trading — no real money required.
            </p>
            <div className="space-y-3 text-left mb-10">
              {[
                ["Scan", "Checks markets every few minutes for edge."],
                ["Qualify", "An LLM vets each setup before placing an order."],
                ["Learn", "Every win or loss writes a lesson to shared memory."],
              ].map(([title, desc]) => (
                <div key={title} className="flex gap-3 items-start">
                  <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  <p className="text-sm"><span className="font-medium">{title} — </span><span className="text-muted-foreground">{desc}</span></p>
                </div>
              ))}
            </div>
            <Button className="w-full rounded-full gap-2" onClick={() => setStep("connect")}>
              Connect Kalshi <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* ── Step 2: Connect Kalshi ──────────────────────────────── */}
        {step === "connect" && (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight mb-1">Connect your Kalshi account</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Paper trading works without this. Only needed when you're ready for real money.
              Generate keys at <span className="font-mono text-xs">kalshi.com → Account → API Keys</span>.
            </p>
            <div className="space-y-4 mb-5">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">API Key ID</Label>
                <Input
                  type="password"
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">RSA Private Key</Label>
                <Input
                  type="password"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="Paste PEM private key"
                  className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
                />
              </div>
            </div>

            {pingStatus === "ok" && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400 mb-4">
                Connected {balance !== null ? `— Kalshi balance: $${balance.toFixed(2)}` : "successfully."}
              </div>
            )}
            {pingStatus === "fail" && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
                {pingError ?? "Connection failed. Check your key ID and private key."}
              </div>
            )}

            <div className="space-y-2">
              {pingStatus === "ok" ? (
                <Button
                  className="w-full rounded-full gap-2"
                  onClick={() => setStep("mode")}
                >
                  <ArrowRight className="h-4 w-4" />
                  Continue
                </Button>
              ) : (
                <Button
                  className="w-full rounded-full gap-2"
                  onClick={testConnection}
                  disabled={saving || pingStatus === "testing" || (!keyId.trim() && !privateKey.trim())}
                >
                  {(saving || pingStatus === "testing") && <Loader2 className="h-4 w-4 animate-spin" />}
                  {pingStatus === "fail" ? <AlertCircle className="h-4 w-4" /> : null}
                  {saving || pingStatus === "testing" ? "Testing…" : "Save & Test Connection"}
                </Button>
              )}
              {pingStatus !== "ok" && (
                <Button
                  variant="ghost"
                  className="w-full rounded-full text-muted-foreground text-sm"
                  onClick={() => setStep("mode")}
                >
                  Skip — start with paper trading
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 3: Choose mode ─────────────────────────────────── */}
        {step === "mode" && (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight mb-1">How do you want to trade?</h1>
            <p className="text-sm text-muted-foreground mb-8">
              Start with paper trading to see the system in action before any real money is involved.
            </p>
            <div className="space-y-3 mb-8">
              <button
                onClick={() => chooseModeAndContinue("paper")}
                className="w-full text-left rounded-2xl border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors px-5 py-4"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">Paper Trading</span>
                  <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">Free</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Agent executes simulated trades using real market prices. Full strategy engine, no real money at risk.
                </p>
              </button>
              <button
                onClick={() => chooseModeAndContinue("live")}
                className="w-full text-left rounded-2xl border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors px-5 py-4"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">Live Trading</span>
                  <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full font-medium">Requires Starter plan</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Real orders placed on your Kalshi account. Requires an active API key and a paid subscription.
                </p>
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Agent is live ───────────────────────────────── */}
        {step === "live" && (
          <div className="text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-6">
              <Zap className="h-7 w-7 text-emerald-500" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Your agent is running.</h1>
            <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
              Three strategies are active in paper mode. The agent scans Kalshi markets every few minutes — first trades typically appear within 10–30 minutes.
            </p>
            <div className="space-y-2 text-left mb-8">
              {[
                ["S-001", "Surface Arbitrage", "Exploits bracket mispricing in S&P 500, BTC, and ETH markets — structural edge, direction-agnostic"],
                ["S-002", "Resolution Fade", "Buys NO on overpriced contracts near resolution, fading market overconfidence"],
                ["S-005", "Weather Edge", "Trades NWS forecast vs Kalshi implied temperature divergence"],
              ].map(([id, name, desc]) => (
                <div key={id} className="rounded-xl bg-secondary/50 px-4 py-3 flex items-start gap-3">
                  <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded mt-0.5 shrink-0">{id}</span>
                  <div>
                    <p className="text-sm font-medium">{name}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <Button className="w-full rounded-full gap-2" onClick={() => finishOnboarding("/", chosenMode)}>
              Go to dashboard <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
