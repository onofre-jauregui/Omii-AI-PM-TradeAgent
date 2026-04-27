import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, Loader2, AlertCircle, ArrowRight } from "lucide-react";

const KALSHI_PING_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/kalshi-ping`;

type Step = "welcome" | "connect" | "mode";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");

  // Kalshi key fields
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [pingStatus, setPingStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [pingError, setPingError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  async function saveKalshiKey() {
    if (!keyId.trim() || !privateKey.trim()) return;
    setSaving(true);
    setSaveStatus("idle");
    try {
      const { error } = await supabase.from("api_keys").upsert(
        { provider: "kalshi_live", key_id: keyId.trim(), encrypted_secret: privateKey.trim(), updated_at: new Date().toISOString() },
        { onConflict: "provider" }
      );
      if (error) throw error;
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (saveStatus !== "saved") {
      await saveKalshiKey();
      if (saveStatus === "error") return;
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
          {(["welcome", "connect", "mode"] as Step[]).map((s) => (
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
              <Button
                className="w-full rounded-full gap-2"
                onClick={testConnection}
                disabled={saving || pingStatus === "testing" || (!keyId.trim() && !privateKey.trim())}
              >
                {(saving || pingStatus === "testing") && <Loader2 className="h-4 w-4 animate-spin" />}
                {pingStatus === "ok" ? <CheckCircle className="h-4 w-4" /> : null}
                {pingStatus === "fail" ? <AlertCircle className="h-4 w-4" /> : null}
                {saving || pingStatus === "testing" ? "Testing…" : pingStatus === "ok" ? "Connected" : "Save & Test Connection"}
              </Button>
              <Button
                variant="ghost"
                className="w-full rounded-full text-muted-foreground text-sm"
                onClick={() => setStep("mode")}
              >
                Skip — I'll use paper mode for now
              </Button>
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
                onClick={() => navigate("/")}
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
                onClick={() => navigate("/")}
                className="w-full text-left rounded-2xl border border-border bg-secondary/30 hover:bg-secondary/60 transition-colors px-5 py-4 opacity-60"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">Live Trading</span>
                  <span className="text-[10px] bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">Requires Starter plan</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Real orders placed on your Kalshi account. Requires an active API key and a paid subscription.
                </p>
              </button>
            </div>
            <Button className="w-full rounded-full gap-2" onClick={() => navigate("/")}>
              Go to dashboard <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
