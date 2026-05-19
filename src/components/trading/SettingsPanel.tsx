import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Save, Loader2, CheckCircle, AlertCircle, Circle, Cpu } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

const FALLBACK_MODELS = [
  { id: "openai/gpt-4.1",              name: "GPT-4.1",           provider: "OpenAI",    tier: "recommended" },
  { id: "openai/gpt-4.1-mini",         name: "GPT-4.1 Mini",      provider: "OpenAI",    tier: "fast"        },
  { id: "openai/gpt-4o",               name: "GPT-4o",            provider: "OpenAI",    tier: "smart"       },
  { id: "openai/gpt-4o-mini",          name: "GPT-4o Mini",       provider: "OpenAI",    tier: "cheap"       },
  { id: "google/gemini-2.5-pro",       name: "Gemini 2.5 Pro",    provider: "Google",    tier: "smart"       },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", tier: "smart"       },
  { id: "anthropic/claude-opus-4-7",   name: "Claude Opus 4.7",   provider: "Anthropic", tier: "premium"     },
];

interface AIModel { id: string; name: string; provider: string; tier?: string; }

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string)?.trim() ?? "";
const SAVE_KALSHI_KEY_URL = `${SUPABASE_URL}/functions/v1/save-kalshi-key`;

function StatusBadge({ saved }: { saved: boolean }) {
  return saved ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-profit bg-profit/10 px-2.5 py-1 rounded-full shrink-0">
      <CheckCircle className="h-3 w-3" /> Configured
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-secondary px-2.5 py-1 rounded-full shrink-0">
      <Circle className="h-3 w-3" /> Not configured
    </span>
  );
}

export function SettingsPanel() {
  const [kalshiLive, setKalshiLive] = useState({ key_id: "", private_key: "" });
  const [aiKeys, setAiKeys] = useState({ openrouter: "", openai: "", anthropic: "", google: "" });

  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [kalshiSaving, setKalshiSaving] = useState(false);
  const [kalshiSaveStatus, setKalshiSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const [models] = useState<AIModel[]>(FALLBACK_MODELS);
  const [selectedModel, setSelectedModel] = useState("openai/gpt-4o-mini");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveStatus, setModelSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const [notifications, setNotifications] = useState({
    tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
  });

  const loadSavedKeys = useCallback(async () => {
    const { data } = await supabase.from("api_keys").select("provider, key_id");
    if (data) {
      setSavedProviders(new Set(data.map(r => r.provider)));
      const kalshi = data.find(r => r.provider === "kalshi_live");
      if (kalshi) setKalshiLive(prev => ({ ...prev, key_id: kalshi.key_id }));
      const modelRow = data.find(r => r.provider === "model_agent");
      if (modelRow?.key_id) setSelectedModel(modelRow.key_id);
    }
  }, []);

  const handleSaveModel = async () => {
    setModelSaving(true);
    setModelSaveStatus("idle");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      await supabase.from("api_keys").upsert(
        { provider: "model_agent", key_id: selectedModel, user_id: user.id, updated_at: new Date().toISOString() },
        { onConflict: "provider" }
      );
      setModelSaveStatus("success");
      setTimeout(() => setModelSaveStatus("idle"), 3000);
    } catch {
      setModelSaveStatus("error");
    } finally {
      setModelSaving(false);
    }
  };

  useEffect(() => {
    loadSavedKeys();
  }, [loadSavedKeys]);

  const handleSaveAiKeys = async () => {
    setAiSaving(true);
    setAiSaveStatus("idle");
    try {
      const keysToSave = [
        aiKeys.openrouter ? { provider: "openrouter", key_id: "default", encrypted_secret: aiKeys.openrouter } : null,
        aiKeys.openai     ? { provider: "openai",     key_id: "default", encrypted_secret: aiKeys.openai }     : null,
        aiKeys.anthropic  ? { provider: "anthropic",  key_id: "default", encrypted_secret: aiKeys.anthropic }  : null,
        aiKeys.google     ? { provider: "google",     key_id: "default", encrypted_secret: aiKeys.google }     : null,
      ].filter(Boolean) as { provider: string; key_id: string; encrypted_secret: string }[];

      for (const key of keysToSave) {
        await supabase.from("api_keys").upsert(
          { ...key, updated_at: new Date().toISOString() },
          { onConflict: "provider" }
        );
      }
      await loadSavedKeys();
      setAiSaveStatus("success");
      setTimeout(() => setAiSaveStatus("idle"), 3000);
    } catch {
      setAiSaveStatus("error");
    } finally {
      setAiSaving(false);
    }
  };

  const handleSaveKalshiKeys = async () => {
    if (!kalshiLive.key_id || !kalshiLive.private_key) return;
    setKalshiSaving(true);
    setKalshiSaveStatus("idle");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(SAVE_KALSHI_KEY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key_id: kalshiLive.key_id.trim(), private_key: kalshiLive.private_key.trim() }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error ?? "Save failed");
      await loadSavedKeys();
      setKalshiSaveStatus("success");
      setTimeout(() => setKalshiSaveStatus("idle"), 3000);
    } catch {
      setKalshiSaveStatus("error");
    } finally {
      setKalshiSaving(false);
    }
  };


  return (
    <div className="space-y-8 apple-reveal">
      <div>
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">API keys are stored securely in your database and used by the agent and trading engine.</p>
      </div>

      {/* ── Default AI Model ────────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Default AI Model</h3>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Source of truth</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            This model is used by the agent, qualify gate, and all automated trading decisions. The Agent tab reflects this setting.
          </p>
        </div>
        <div className="px-6 py-5 space-y-3">
          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="rounded-xl border border-border bg-secondary/50 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <div className="flex items-center gap-2">
                    <span>{m.name}</span>
                    <span className="text-[10px] text-muted-foreground">{m.provider}</span>
                    {m.tier === "recommended" && (
                      <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded-full font-medium">Recommended</span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            The system routes to the provider whose API key you have configured. If the selected model's provider key is missing, it falls back to OpenRouter automatically.
          </p>
        </div>
        <div className="px-6 pb-5">
          <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveModel} disabled={modelSaving}>
            {modelSaving ? <Loader2 className="h-4 w-4 animate-spin" /> :
             modelSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
             modelSaveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
             <Save className="h-4 w-4" />}
            {modelSaveStatus === "success" ? "Model saved — now used across all agent runs" :
             modelSaveStatus === "error" ? "Save failed — try again" :
             "Set as Default Model"}
          </Button>
        </div>
      </div>

      {/* ── AI Model Keys ───────────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">AI Model Keys</h3>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Required for agent</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Add at least one key. OpenRouter is recommended — one key unlocks 200+ models from all providers.
          </p>
        </div>

        {/* OpenRouter */}
        <div className="px-6 py-5 border-b border-border space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">OpenRouter</p>
                <span className="text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded-full font-medium">Recommended</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Access GPT-4o, Claude, Gemini, Llama and 200+ models with one key. ~$5 to start.
              </p>
            </div>
            <StatusBadge saved={savedProviders.has("openrouter")} />
          </div>
          <Input
            type="password"
            value={aiKeys.openrouter}
            onChange={(e) => setAiKeys(prev => ({ ...prev, openrouter: e.target.value }))}
            placeholder="sk-or-v1-..."
            className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
          />
        </div>

        {/* OpenAI */}
        <div className="px-6 py-5 border-b border-border space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">OpenAI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use GPT-4o, o1, o3 and other OpenAI models directly via the OpenAI API.
              </p>
            </div>
            <StatusBadge saved={savedProviders.has("openai")} />
          </div>
          <Input
            type="password"
            value={aiKeys.openai}
            onChange={(e) => setAiKeys(prev => ({ ...prev, openai: e.target.value }))}
            placeholder="sk-proj-..."
            className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
          />
        </div>

        {/* Anthropic */}
        <div className="px-6 py-5 border-b border-border space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Anthropic</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use Claude Opus, Sonnet, and Haiku directly via the Anthropic API.
              </p>
            </div>
            <StatusBadge saved={savedProviders.has("anthropic")} />
          </div>
          <Input
            type="password"
            value={aiKeys.anthropic}
            onChange={(e) => setAiKeys(prev => ({ ...prev, anthropic: e.target.value }))}
            placeholder="sk-ant-api03-..."
            className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
          />
        </div>

        {/* Google AI */}
        <div className="px-6 py-5 border-b border-border space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Google AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use Gemini 2.5 Pro, Flash, and other Gemini models via Google AI Studio.
              </p>
            </div>
            <StatusBadge saved={savedProviders.has("google")} />
          </div>
          <Input
            type="password"
            value={aiKeys.google}
            onChange={(e) => setAiKeys(prev => ({ ...prev, google: e.target.value }))}
            placeholder="AIzaSy..."
            className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
          />
        </div>

        <div className="px-6 py-4">
          <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveAiKeys} disabled={aiSaving}>
            {aiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> :
             aiSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
             aiSaveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
             <Save className="h-4 w-4" />}
            {aiSaveStatus === "success" ? "Saved — models now available in Agent tab" :
             aiSaveStatus === "error" ? "Save failed — try again" :
             "Save AI Keys"}
          </Button>
        </div>
      </div>

      {/* ── Kalshi Live Trading ─────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Kalshi — Live Trading</h3>
              <StatusBadge saved={savedProviders.has("kalshi_live")} />
            </div>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Real money only</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Paper trading works without these. Only add when you're ready to trade with real money on Kalshi.
          </p>
        </div>

        <div className="px-6 py-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">API Key ID</Label>
              <Input
                type="password"
                value={kalshiLive.key_id}
                onChange={(e) => setKalshiLive(prev => ({ ...prev, key_id: e.target.value }))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">RSA Private Key</Label>
              <Input
                type="password"
                value={kalshiLive.private_key}
                onChange={(e) => setKalshiLive(prev => ({ ...prev, private_key: e.target.value }))}
                placeholder="Paste PEM private key"
                className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Generate at kalshi.com → Account → API Keys. Your private key signs requests and never leaves your server.
          </p>
        </div>

        <div className="px-6 pb-5">
          <Button
            className="w-full rounded-full gap-2 text-sm"
            onClick={handleSaveKalshiKeys}
            disabled={kalshiSaving || (!kalshiLive.key_id || !kalshiLive.private_key)}
          >
            {kalshiSaving ? <Loader2 className="h-4 w-4 animate-spin" /> :
             kalshiSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
             kalshiSaveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
             <Save className="h-4 w-4" />}
            {kalshiSaveStatus === "success" ? "Kalshi credentials saved" :
             kalshiSaveStatus === "error" ? "Save failed — try again" :
             "Save Kalshi Keys"}
          </Button>
        </div>
      </div>

      {/* ── Notifications ──────────────────────────────────────── */}
      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">Notifications</h3>
        </div>
        {[
          { key: "tradeExecuted", label: "Trade Executed" },
          { key: "positionClosed", label: "Position Closed" },
          { key: "stopLossHit", label: "Stop Loss Triggered" },
          { key: "dailySummary", label: "Daily Summary" },
          { key: "agentAlerts", label: "Agent Alerts" },
        ].map((item) => (
          <div key={item.key} className="flex items-center justify-between py-1">
            <Label className="text-sm">{item.label}</Label>
            <Switch
              checked={notifications[item.key as keyof typeof notifications]}
              onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, [item.key]: checked }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
