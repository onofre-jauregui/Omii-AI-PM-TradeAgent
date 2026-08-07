import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { buildSeededStrategies } from "@/lib/onboardingSeed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { CheckCircle, Loader2, AlertCircle, ArrowRight, Zap } from "lucide-react";

const SUPABASE_URL    = import.meta.env.VITE_SUPABASE_URL ?? "";
const KALSHI_PING_URL = `${SUPABASE_URL}/functions/v1/kalshi-ping`;
const SAVE_KEY_URL    = `${SUPABASE_URL}/functions/v1/save-kalshi-key`;
const SAVE_AI_KEY_URL = `${SUPABASE_URL}/functions/v1/save-ai-key`;

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
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) return;
      // Pre-populate display name from OAuth metadata
      const meta = session.user.user_metadata ?? {};
      const name = meta.full_name ?? meta.name ?? "";
      if (name) setDisplayName(name);
      // Already-onboarded users who navigate back go straight to dashboard
      const { data: profile } = await supabase
        .from("profiles").select("onboarding_completed").eq("id", session.user.id).single();
      if (profile?.onboarding_completed) navigate("/");
    });
  }, [navigate]);

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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Not authenticated");

      // Use the save-ai-key edge function for AES-256-GCM encryption at rest —
      // same path as SettingsPanel so keys are consistent in the DB schema.
      const resp = await fetch(SAVE_AI_KEY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, api_key: apiKey.trim() }),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
      if (!resp.ok || !json.ok) throw new Error(json.error ?? `Server error ${resp.status}`);

      // Set the default model for this provider so the agent has something
      // to use immediately without a second visit to Settings.
      await supabase.from("api_keys").upsert(
        {
          provider:   "model_agent",
          key_id:     DEFAULT_MODEL[selectedProvider] ?? "openai/gpt-4o-mini",
          user_id:    session.user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

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
    is_us_person:    false,
  });
  const allAcksChecked = Object.values(ackChecked).every(Boolean);

  const [finishing, setFinishing] = useState(false);

  // ── finish ────────────────────────────────────────────────────────────
  // Returns true on success. destination=null seeds data without navigating.
  async function finishOnboarding(destination: string | null, mode?: "paper" | "live"): Promise<boolean> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Session expired — please sign in again."); return false; }

    setFinishing(true);
    try {
      const { error: profileErr } = await supabase.from("profiles").upsert(
        { id: user.id, onboarding_completed: true, ...(mode ? { trading_mode: mode } : {}) },
        { onConflict: "id" }
      );
      if (profileErr) throw profileErr;

      const { error: stratErr } = await supabase
        .from("strategies")
        .upsert(buildSeededStrategies(user.id), { onConflict: "id" });
      if (stratErr) throw stratErr;

      // Seed risk_settings so auto-trade doesn't fall back to the system default (10 positions).
      // risk_settings has one row per (user_id, mode); seed BOTH and conflict on
      // (user_id, mode) — the signup trigger may have already created these rows.
      // Paper (where the user starts) gets the roomier onboarding defaults; live
      // stays conservative (the tier ceiling clamps it at trade time regardless).
      const { error: riskErr } = await supabase.from("risk_settings").upsert(
        [
          {
            user_id: user.id,
            mode: "paper",
            max_position_size: 20,
            max_open_positions: 25,
            max_daily_trades: 50,
            allocated_capital: 500,
            max_daily_loss: 100,
            max_drawdown_pct: 20,
          },
          {
            user_id: user.id,
            mode: "live",
            max_position_size: 20,
            max_open_positions: 3,
            max_daily_trades: 30,
            allocated_capital: 500,
            max_daily_loss: 100,
            max_drawdown_pct: 10,
          },
        ],
        { onConflict: "user_id,mode" }
      );
      if (riskErr) throw riskErr;

      if (destination) navigate(destination);
      return true;
    } catch (err) {
      console.error("Onboarding finalize failed:", err);
      toast.error("Setup failed — please try again or contact support.");
      return false;
    } finally {
      setFinishing(false);
    }
  }

  async function chooseModeAndContinue(mode: "paper" | "live") {
    setChosenMode(mode);
    if (mode === "live") {
      await finishOnboarding("/billing", "live");
    } else {
      // Seed strategies + mark onboarding complete before advancing to the
      // confirmation step — so a browser close after this point doesn't force
      // the user back through the whole flow on next login.
      const ok = await finishOnboarding(null, "paper");
      if (ok) setStep("live");
    }
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
                {
                  key: "is_us_person" as const,
                  text: "I confirm I am a US resident and am legally eligible to trade prediction markets on Kalshi. I understand that Kalshi is a CFTC-regulated exchange restricted to US persons.",
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
                disabled={finishing}
                className="w-full text-left rounded-2xl border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed"
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
                disabled={finishing}
                className="w-full text-left rounded-2xl border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors px-5 py-4 disabled:opacity-50 disabled:cursor-not-allowed"
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
              One strategy is active in paper mode. The agent scans Kalshi markets every few minutes — first trades typically appear within 10–30 minutes.
            </p>
            <div className="space-y-2 text-left mb-8">
              {[
                ["S-001", "Surface Arbitrage", "Exploits bracket mispricing in S&P 500, BTC, and ETH markets — structural edge, direction-agnostic", true],
                ["S-002", "Resolution Fade",   "Fades overreaction near resolution. Off by default — negative expectancy in current conditions.", false],
                ["S-005", "Weather Edge",      "NWS forecast vs Kalshi implied temperature. Off by default — negative expectancy in current conditions.", false],
              ].map(([id, name, desc, on]) => (
                <div key={id as string} className="rounded-xl bg-secondary/50 px-4 py-3 flex items-start gap-3">
                  <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded mt-0.5 shrink-0">{id}</span>
                  <div>
                    <p className="text-sm font-medium flex items-center gap-2">
                      {name}
                      <span className={`text-[10px] font-normal px-1.5 py-0.5 rounded ${on ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                        {on ? "Active" : "Off"}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mb-8 leading-relaxed">
              You can enable the others from the Strategies panel once you&rsquo;ve reviewed their track record.
            </p>
            <Button
              className="w-full rounded-full gap-2"
              onClick={() => navigate("/")}
            >
              <ArrowRight className="h-4 w-4" />
              Go to dashboard
            </Button>
          </div>
        )}

      </div>
    </div>
  );
}
