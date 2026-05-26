import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, Loader2, AlertCircle, ArrowRight, Zap } from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const KALSHI_PING_URL = `${SUPABASE_URL}/functions/v1/kalshi-ping`;
const SAVE_KEY_URL    = `${SUPABASE_URL}/functions/v1/save-kalshi-key`;

type Step = "welcome" | "name" | "ai_key" | "connect" | "risk_ack" | "mode" | "live";
const STEPS: Step[] = ["welcome", "name", "ai_key", "connect", "risk_ack", "mode", "live"];

const AI_PROVIDERS = [
  { id: "openrouter", label: "OpenRouter",  placeholder: "sk-or-v1-…",       recommended: true  },
  { id: "anthropic",  label: "Anthropic",   placeholder: "sk-ant-api03-…",   recommended: false },
  { id: "google",     label: "Google AI",   placeholder: "AIzaSy…",          recommended: false },
  { id: "openai",     label: "OpenAI",      placeholder: "sk-proj-…",        recommended: false },
] as const;

// Default model to set per provider so the agent has a model selected from day 1
const DEFAULT_MODEL: Record<string, string> = {
  openrouter: "openai/gpt-4.1-mini",
  anthropic:  "anthropic/claude-sonnet-4-6",
  google:     "google/gemini-2.5-pro",
  openai:     "openai/gpt-4o",
};

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [chosenMode, setChosenMode] = useState<"paper" | "live">("paper");

  // ── name step ────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

  useEffect(() => {
    // Pre-populate display name from Google OAuth metadata the moment component mounts
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) return;
      const meta = session.user.user_metadata ?? {};
      const name = meta.full_name ?? meta.name ?? "";
      if (name) setDisplayName(name);
    });
  }, []);

  async function saveName() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setNameSaving(true);
    await supabase.from("profiles").upsert(
      { id: user.id, display_name: displayName.trim() || null },
      { onConflict: "id" }
    );
    setNameSaving(false);
    setStep("ai_key");
  }

  // ── ai_key step ───────────────────────────────────────────────────────
  const [selectedProvider, setSelectedProvider] = useState<string>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [aiSaving, setAiSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<"idle" | "saved" | "error">("idle");

  // Clear the key field whenever the user switches provider
  function handleProviderChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedProvider(e.target.value);
    setApiKey("");
    setAiStatus("idle");
  }

  async function saveAiKey() {
    if (!apiKey.trim()) return;
    setAiSaving(true);
    setAiStatus("idle");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Delete-then-insert matches the Settings page pattern exactly.
      // AI provider keys are stored the same way: encrypted_secret holds the
      // raw key value; the column name reflects a legacy intent — RLS on
      // api_keys enforces per-user isolation so no server-side encryption is
      // needed for provider keys (only Kalshi RSA keys use the edge function).
      await supabase.from("api_keys")
        .delete()
        .eq("user_id", user.id)
        .eq("provider", selectedProvider);

      const { error } = await supabase.from("api_keys").insert({
        provider:          selectedProvider,
        key_id:            "default",
        encrypted_secret:  apiKey.trim(),
        user_id:           user.id,
        updated_at:        new Date().toISOString(),
      });
      if (error) throw error;

      // Set the default model for this provider so the agent has something
      // to use immediately without a second visit to Settings.
      await supabase.from("api_keys").delete().eq("user_id", user.id).eq("provider", "model_agent");
      await supabase.from("api_keys").insert({
        provider:         "model_agent",
        key_id:           DEFAULT_MODEL[selectedProvider] ?? "openai/gpt-4o-mini",
        encrypted_secret: DEFAULT_MODEL[selectedProvider] ?? "openai/gpt-4o-mini",
        user_id:          user.id,
        updated_at:       new Date().toISOString(),
      });

      setAiStatus("saved");
    } catch (err) {
      console.error("AI key save failed:", err);
      setAiStatus("error");
    } finally {
      setAiSaving(false);
    }
  }

  // ── connect step (Kalshi) ─────────────────────────────────────────────
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [kalshiSaving, setKalshiSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pingStatus, setPingStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [pingError, setPingError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  async function saveKalshiKey(): Promise<boolean> {
    if (!keyId.trim() || !privateKey.trim()) return false;
    setKalshiSaving(true);
    setSaveStatus("idle");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(SAVE_KEY_URL, {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${session?.access_token}`,
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
      setKalshiSaving(false);
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
        headers: { Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await resp.json();
      if (json.ok) { setPingStatus("ok"); setBalance(json.balance_usd ?? null); }
      else { setPingStatus("fail"); setPingError(json.error ?? "Connection failed"); }
    } catch (e) {
      setPingStatus("fail");
      setPingError(e instanceof Error ? e.message : "Connection failed");
    }
  }

  // ── risk_ack step ─────────────────────────────────────────────────────
  const [ackChecked, setAckChecked] = useState({
    understand_risk: false,
    agent_trades:    false,
    own_funds:       false,
  });
  const allAcksChecked = Object.values(ackChecked).every(Boolean);

  // ── finish ────────────────────────────────────────────────────────────
  async function finishOnboarding(destination: string, mode?: "paper" | "live") {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").upsert(
        { id: user.id, onboarding_completed: true, ...(mode ? { trading_mode: mode } : {}) },
        { onConflict: "id" }
      );
      const tradeMode = mode ?? "paper";
      const uid8 = user.id.replace(/-/g, "").slice(0, 8);
      await supabase.from("strategies").upsert(
        [
          {
            id: `S-001-${uid8}`, template_id: "S-001", name: "Surface Arbitrage",
            description: "Exploits bracket-sum mispricing in KXINX/KXBTC/KXETH markets.",
            instructions: "Read surface_alerts for bracket_sum_violation. Buy NO on the most overpriced YES legs (yesAsk descending). Max 3 legs per event at $15/leg. Mark alert is_exploited after fill. No LLM gate — structural edge.",
            active: true, mode: tradeMode, starting_balance: 500, user_id: user.id,
          },
          {
            id: `S-002-${uid8}`, template_id: "S-002", name: "Resolution Fade",
            description: "Fade overreaction price moves in markets 2–7 days from resolution.",
            instructions: "Use fetch_signals filtered to time_value_score >= 0.7 and edge_score >= 0.4. Fade sentiment-driven extremes with $20–$40 limit orders. Exit when price reverts 10¢ toward prior range.",
            active: true, mode: tradeMode, starting_balance: 1000, user_id: user.id,
          },
          {
            id: `S-005-${uid8}`, template_id: "S-005", name: "Weather Edge",
            description: "Trades NWS forecast vs Kalshi implied temperature divergence.",
            instructions: "Compare NWS probability-of-precipitation and temperature forecasts to Kalshi Weather markets. Trade when divergence exceeds 15¢. Size $15–$30.",
            active: true, mode: tradeMode, starting_balance: 1000, user_id: user.id,
          },
        ],
        { onConflict: "id" }
      );
    }
    navigate(destination);
  }

  function chooseModeAndContinue(mode: "paper" | "live") {
    setChosenMode(mode);
    if (mode === "live") finishOnboarding("/billing", "live");
    else setStep("live");
  }

  const currentProvider = AI_PROVIDERS.find(p => p.id === selectedProvider) ?? AI_PROVIDERS[0];

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">

        {/* Progress dots — one per step */}
        <div className="flex gap-1.5 mb-10 justify-center">
          {STEPS.map((s) => (
            <div key={s} className={`h-1.5 rounded-full transition-all ${step === s ? "w-6 bg-foreground" : "w-1.5 bg-muted"}`} />
          ))}
        </div>

        {/* ── Step 1: Welcome ─────────────────────────────────────────── */}
        {step === "welcome" && (
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight mb-3">You're in.</h1>
            <p className="text-muted-foreground leading-relaxed mb-10">
              OMII Trade is an AI agent that watches Kalshi prediction markets 24/7 and places trades on your behalf. Start with paper trading — no real money required.
            </p>
            <div className="space-y-3 text-left mb-10">
              {[
                ["Scan",    "Checks markets every few minutes for edge."],
                ["Qualify", "An LLM vets each setup before placing an order."],
                ["Learn",   "Every win or loss writes a lesson to shared memory."],
              ].map(([title, desc]) => (
                <div key={title} className="flex gap-3 items-start">
                  <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  <p className="text-sm"><span className="font-medium">{title} — </span><span className="text-muted-foreground">{desc}</span></p>
                </div>
              ))}
            </div>
            <Button className="w-full rounded-full gap-2" onClick={() => setStep("name")}>
              Get started <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* ── Step 2: Display name ─────────────────────────────────────── */}
        {step === "name" && (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight mb-1">What should we call you?</h1>
            <p className="text-sm text-muted-foreground mb-6">
              This is your display name in the app. You can change it later in Settings.
            </p>
            <div className="space-y-1.5 mb-6">
              <Label className="text-xs text-muted-foreground">Display name</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && displayName.trim() && saveName()}
                placeholder="Your name"
                className="rounded-xl border border-border bg-secondary/50 text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Button
                className="w-full rounded-full gap-2"
                onClick={saveName}
                disabled={nameSaving || !displayName.trim()}
              >
                {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {nameSaving ? "Saving…" : "Continue"}
              </Button>
              <Button
                variant="ghost"
                className="w-full rounded-full text-muted-foreground text-sm"
                onClick={() => setStep("ai_key")}
              >
                Skip for now
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: AI provider key ──────────────────────────────────── */}
        {step === "ai_key" && (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight mb-1">Connect an AI provider</h1>
            <p className="text-sm text-muted-foreground mb-6">
              The agent uses an LLM to qualify each trade. OpenRouter is recommended — one key covers every model. You can add this later in Settings.
            </p>

            <div className="space-y-4 mb-6">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Provider</Label>
                <select
                  value={selectedProvider}
                  onChange={handleProviderChange}
                  className="w-full rounded-xl border border-border bg-secondary/50 text-sm px-3 py-2.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{p.recommended ? " (Recommended)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {selectedProvider === "openrouter" && (
                <p className="text-xs text-muted-foreground -mt-2">
                  Get a key at <span className="font-mono">openrouter.ai</span> — $5 covers hundreds of agent runs.
                </p>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">API Key</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setAiStatus("idle"); }}
                  placeholder={currentProvider.placeholder}
                  className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
                />
              </div>
            </div>

            {aiStatus === "saved" && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400 mb-4 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 shrink-0" />
                {currentProvider.label} key saved — default model set automatically.
              </div>
            )}
            {aiStatus === "error" && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Save failed — check your key and try again.
              </div>
            )}

            <div className="space-y-2">
              {aiStatus === "saved" ? (
                <Button className="w-full rounded-full gap-2" onClick={() => setStep("connect")}>
                  <ArrowRight className="h-4 w-4" /> Continue
                </Button>
              ) : (
                <Button
                  className="w-full rounded-full gap-2"
                  onClick={saveAiKey}
                  disabled={aiSaving || !apiKey.trim()}
                >
                  {aiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {aiSaving ? "Saving…" : "Save & Continue"}
                </Button>
              )}
              <Button
                variant="ghost"
                className="w-full rounded-full text-muted-foreground text-sm"
                onClick={() => setStep("connect")}
              >
                Skip — add later in Settings
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: Connect Kalshi ───────────────────────────────────── */}
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
                <Button className="w-full rounded-full gap-2" onClick={() => setStep("risk_ack")}>
                  <ArrowRight className="h-4 w-4" /> Continue
                </Button>
              ) : (
                <Button
                  className="w-full rounded-full gap-2"
                  onClick={testConnection}
                  disabled={kalshiSaving || pingStatus === "testing" || (!keyId.trim() && !privateKey.trim())}
                >
                  {(kalshiSaving || pingStatus === "testing") && <Loader2 className="h-4 w-4 animate-spin" />}
                  {pingStatus === "fail" ? <AlertCircle className="h-4 w-4" /> : null}
                  {kalshiSaving || pingStatus === "testing" ? "Testing…" : "Save & Test Connection"}
                </Button>
              )}
              {pingStatus !== "ok" && (
                <Button
                  variant="ghost"
                  className="w-full rounded-full text-muted-foreground text-sm"
                  onClick={() => setStep("risk_ack")}
                >
                  Skip — start with paper trading
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 5: Risk acknowledgment ──────────────────────────────── */}
        {step === "risk_ack" && (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight mb-1">Before you trade</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Please read and confirm each of the following. This is required to continue.
            </p>
            <div className="space-y-4 mb-8">
              {[
                {
                  key: "understand_risk" as const,
                  text: "I understand that trading prediction markets involves substantial risk of loss, and I may lose some or all of the funds I allocate to this agent.",
                },
                {
                  key: "agent_trades" as const,
                  text: "I understand that TradeAgent places real orders on my Kalshi account automatically. I am responsible for configuring and monitoring the agent's capital limits and risk settings.",
                },
                {
                  key: "own_funds" as const,
                  text: "I am only trading with funds I can afford to lose. I have read and agree to the Terms of Service, including the Limitation of Liability section.",
                },
              ].map(({ key, text }) => (
                <label
                  key={key}
                  className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 cursor-pointer transition-colors ${
                    ackChecked[key]
                      ? "border-emerald-500/40 bg-emerald-500/8"
                      : "border-border bg-secondary/30 hover:bg-secondary/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ackChecked[key]}
                    onChange={(e) => setAckChecked(prev => ({ ...prev, [key]: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
                  />
                  <span className="text-sm leading-relaxed">{text}</span>
                </label>
              ))}
            </div>
            <div className="space-y-2">
              <Button
                className="w-full rounded-full gap-2"
                onClick={() => setStep("mode")}
                disabled={!allAcksChecked}
              >
                <ArrowRight className="h-4 w-4" /> I agree — continue
              </Button>
              <p className="text-[11px] text-center text-muted-foreground">
                Full terms at <a href="/terms" target="_blank" className="underline hover:text-foreground">/terms</a>
              </p>
            </div>
          </div>
        )}

        {/* ── Step 6: Choose mode ──────────────────────────────────────── */}
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

        {/* ── Step 7: Agent is live ────────────────────────────────────── */}
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
                ["S-001", "Surface Arbitrage",  "Exploits bracket mispricing in S&P 500, BTC, and ETH markets — structural edge, direction-agnostic"],
                ["S-002", "Resolution Fade",    "Buys NO on overpriced contracts near resolution, fading market overconfidence"],
                ["S-005", "Weather Edge",        "Trades NWS forecast vs Kalshi implied temperature divergence"],
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
