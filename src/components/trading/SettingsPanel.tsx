import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Key, Bell, Save, Loader2, CheckCircle, AlertCircle, Circle, Cpu,
  Zap, Check,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

const FALLBACK_MODELS = [
  { id: "openai/gpt-4.1",              name: "GPT-4.1",           provider: "openai",    providerLabel: "OpenAI",    tier: "recommended", color: "bg-emerald-500/10 text-emerald-500" },
  { id: "openai/gpt-4.1-mini",         name: "GPT-4.1 Mini",      provider: "openai",    providerLabel: "OpenAI",    tier: "fast",        color: "bg-emerald-500/10 text-emerald-500" },
  { id: "openai/gpt-4o",               name: "GPT-4o",            provider: "openai",    providerLabel: "OpenAI",    tier: "smart",       color: "bg-emerald-500/10 text-emerald-500" },
  { id: "openai/gpt-4o-mini",          name: "GPT-4o Mini",       provider: "openai",    providerLabel: "OpenAI",    tier: "cheap",       color: "bg-emerald-500/10 text-emerald-500" },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", providerLabel: "Anthropic", tier: "smart",       color: "bg-orange-500/10 text-orange-500" },
  { id: "anthropic/claude-opus-4-7",   name: "Claude Opus 4.7",   provider: "anthropic", providerLabel: "Anthropic", tier: "premium",     color: "bg-orange-500/10 text-orange-500" },
  { id: "google/gemini-2.5-pro",       name: "Gemini 2.5 Pro",    provider: "google",    providerLabel: "Google",    tier: "smart",       color: "bg-blue-500/10 text-blue-500" },
];

const TIER_LABELS: Record<string, string> = {
  recommended: "Recommended", fast: "Fast", smart: "Smart", cheap: "Budget", premium: "Premium",
};

const NOTIF_STORAGE_KEY = "tradeagent_notification_prefs";
const DEFAULT_NOTIFS = {
  tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
};

function loadNotifPrefs() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    return raw ? { ...DEFAULT_NOTIFS, ...JSON.parse(raw) } : DEFAULT_NOTIFS;
  } catch {
    return DEFAULT_NOTIFS;
  }
}

interface AIModel { id: string; name: string; provider: string; providerLabel: string; tier?: string; color: string; }

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

export function SettingsPanel({ userId }: { userId?: string }) {
  const navigate = useNavigate();

  // Profile identity
  const [profileName, setProfileName] = useState("Anon Trader");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileAvatar, setProfileAvatar] = useState("");
  const [subscriptionTier, setSubscriptionTier] = useState("free");
  const [profileSaving, setProfileSaving] = useState(false);

  // Keys
  const [kalshiLive, setKalshiLive] = useState({ key_id: "", private_key: "" });
  const [aiKeys, setAiKeys] = useState({ openrouter: "", openai: "", anthropic: "", google: "" });
  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [kalshiSaving, setKalshiSaving] = useState(false);
  const [kalshiSaveStatus, setKalshiSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [kalshiSaveError, setKalshiSaveError] = useState<string | null>(null);

  // Model selector
  const [models] = useState<AIModel[]>(FALLBACK_MODELS);
  const [selectedModel, setSelectedModel] = useState("openai/gpt-4o-mini");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveStatus, setModelSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Notifications — persisted to localStorage
  const [notifications, setNotifications] = useState(loadNotifPrefs);

  const updateNotif = (key: string, value: boolean) => {
    setNotifications(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const loadAll = useCallback(async (uid: string) => {
    const [{ data: keyRows }, { data: prof }, { data: sub }] = await Promise.all([
      supabase.from("api_keys").select("provider, key_id").eq("user_id", uid),
      supabase.from("profiles").select("display_name, avatar_url").eq("id", uid).maybeSingle(),
      supabase.from("subscriptions").select("tier, status").eq("user_id", uid).maybeSingle(),
    ]);

    if (keyRows) {
      setSavedProviders(new Set(keyRows.map(r => r.provider)));
      const kalshi = keyRows.find(r => r.provider === "kalshi_live");
      if (kalshi) setKalshiLive(prev => ({ ...prev, key_id: kalshi.key_id }));
      const modelRow = keyRows.find(r => r.provider === "model_agent");
      if (modelRow?.key_id) setSelectedModel(modelRow.key_id);
    }

    if (prof?.display_name) setProfileName(prof.display_name);
    if (prof?.avatar_url) setProfileAvatar(prof.avatar_url);
    if (sub?.tier) setSubscriptionTier(sub.tier);
  }, []);

  useEffect(() => { if (userId) loadAll(userId); }, [userId, loadAll]);

  const handleSaveProfile = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setProfileSaving(true);
    await supabase.from("profiles").update({ display_name: profileName, updated_at: new Date().toISOString() }).eq("id", user.id);
    setProfileSaving(false);
  };

  const handleSaveModel = async () => {
    setModelSaving(true);
    setModelSaveStatus("idle");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      await supabase.from("api_keys").delete().eq("user_id", user.id).eq("provider", "model_agent");
      const { error } = await supabase.from("api_keys").insert({
        provider: "model_agent",
        key_id: selectedModel,
        encrypted_secret: selectedModel,
        user_id: user.id,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      setModelSaveStatus("success");
      setTimeout(() => setModelSaveStatus("idle"), 3000);
    } catch (err) {
      console.error("Model save failed:", err);
      setModelSaveStatus("error");
    } finally {
      setModelSaving(false);
    }
  };

  const handleSaveAiKeys = async () => {
    setAiSaving(true);
    setAiSaveStatus("idle");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setAiSaveStatus("error"); setAiSaving(false); return; }
    try {
      const keysToSave = [
        aiKeys.openrouter ? { provider: "openrouter", key_id: "default", encrypted_secret: aiKeys.openrouter } : null,
        aiKeys.openai     ? { provider: "openai",     key_id: "default", encrypted_secret: aiKeys.openai }     : null,
        aiKeys.anthropic  ? { provider: "anthropic",  key_id: "default", encrypted_secret: aiKeys.anthropic }  : null,
        aiKeys.google     ? { provider: "google",     key_id: "default", encrypted_secret: aiKeys.google }     : null,
      ].filter(Boolean) as { provider: string; key_id: string; encrypted_secret: string }[];

      for (const key of keysToSave) {
        // Delete existing row first so we can insert fresh without relying on a
        // specific conflict constraint. Avoids silent upsert failures.
        await supabase.from("api_keys").delete().eq("user_id", user.id).eq("provider", key.provider);
        const { error } = await supabase.from("api_keys").insert({
          ...key,
          user_id: user.id,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      }
      // Update badge state directly — don't re-read from DB which would reset state
      // on any timing issue with the just-written rows.
      setSavedProviders(prev => {
        const next = new Set(prev);
        keysToSave.forEach(k => next.add(k.provider));
        return next;
      });
      setAiSaveStatus("success");
      setTimeout(() => setAiSaveStatus("idle"), 3000);
    } catch (err) {
      console.error("AI key save failed:", err);
      setAiSaveStatus("error");
    } finally {
      setAiSaving(false);
    }
  };

  const handleSaveKalshiKeys = async () => {
    if (!kalshiLive.key_id || !kalshiLive.private_key) return;
    setKalshiSaving(true);
    setKalshiSaveStatus("idle");
    setKalshiSaveError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated — please sign in again");
      const resp = await fetch(SAVE_KALSHI_KEY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key_id: kalshiLive.key_id.trim(), private_key: kalshiLive.private_key.trim() }),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
      if (!resp.ok || !json.ok) throw new Error(json.error ?? `Server error ${resp.status}`);
      setSavedProviders(prev => new Set([...prev, "kalshi_live"]));
      setKalshiSaveStatus("success");
      setTimeout(() => setKalshiSaveStatus("idle"), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      console.error("Kalshi key save failed:", msg);
      setKalshiSaveError(msg);
      setKalshiSaveStatus("error");
    } finally {
      setKalshiSaving(false);
    }
  };

  const tierLabel = (t: string) =>
    ({ free: "Free Trial", starter: "Starter", pro: "Pro", prop: "Prop" }[t] ?? t);
  const tierColor = (t: string) =>
    t === "prop" ? "bg-amber-500/10 text-amber-500" :
    t === "pro"  ? "bg-primary/10 text-primary" :
    t === "starter" ? "bg-emerald-500/10 text-emerald-500" :
    "bg-secondary text-muted-foreground";

  return (
    <div className="space-y-6">
      {/* ── Default AI Model ─────────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Default AI Model</h3>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Source of truth</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Used by the agent, qualify gate, and all automated trading. Falls back to OpenRouter if the provider key is missing.
          </p>
        </div>
        <div className="px-6 py-4 grid grid-cols-1 gap-2">
          {models.map((m) => {
            const isSelected = selectedModel === m.id;
            const keyConfigured = savedProviders.has(m.provider) || savedProviders.has("openrouter");
            return (
              <button
                key={m.id}
                onClick={() => setSelectedModel(m.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-secondary/40 hover:bg-secondary/70"
                }`}
              >
                <div className={`w-2 h-2 rounded-full shrink-0 ${keyConfigured ? "bg-profit" : "bg-muted-foreground/30"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${m.color}`}>
                      {m.providerLabel}
                    </span>
                    {m.tier && (
                      <span className="text-[10px] text-muted-foreground">
                        {TIER_LABELS[m.tier]}
                      </span>
                    )}
                  </div>
                </div>
                {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
              </button>
            );
          })}
        </div>
        <div className="px-6 pb-5">
          <p className="text-[10px] text-muted-foreground mb-3">
            Green dot = provider key configured (or OpenRouter available as fallback). Gray = no key for this provider.
          </p>
          <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveModel} disabled={modelSaving}>
            {modelSaving ? <Loader2 className="h-4 w-4 animate-spin" /> :
             modelSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
             modelSaveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
             <Save className="h-4 w-4" />}
            {modelSaveStatus === "success" ? "Model saved — active across all agent runs" :
             modelSaveStatus === "error" ? "Save failed — try again" :
             "Set as Default"}
          </Button>
        </div>
      </div>

      {/* ── API Keys ─────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">API Keys</h3>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Required for agent</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Add at least one key. OpenRouter is recommended — one key unlocks 200+ models from all providers.
          </p>
        </div>

        {[
          { key: "openrouter" as const, label: "OpenRouter", placeholder: "sk-or-v1-...", badge: "Recommended", desc: "GPT-4o, Claude, Gemini, Llama and 200+ models with one key. ~$5 to start." },
          { key: "openai"     as const, label: "OpenAI",     placeholder: "sk-proj-...",  badge: null,          desc: "GPT-4o, o1, o3 and other OpenAI models directly." },
          { key: "anthropic"  as const, label: "Anthropic",  placeholder: "sk-ant-api03-...", badge: null,      desc: "Claude Opus, Sonnet, and Haiku directly via Anthropic API." },
          { key: "google"     as const, label: "Google AI",  placeholder: "AIzaSy...",    badge: null,          desc: "Gemini 2.5 Pro and other Gemini models via Google AI Studio." },
        ].map((item, i, arr) => (
          <div key={item.key} className={`px-6 py-5 space-y-3 ${i < arr.length - 1 ? "border-b border-border" : ""}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{item.label}</p>
                  {item.badge && (
                    <span className="text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded-full font-medium">{item.badge}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
              </div>
              <StatusBadge saved={savedProviders.has(item.key)} />
            </div>
            <Input
              type="password"
              value={aiKeys[item.key]}
              onChange={(e) => setAiKeys(prev => ({ ...prev, [item.key]: e.target.value }))}
              placeholder={item.placeholder}
              className="rounded-xl border border-border bg-secondary/50 text-sm font-mono placeholder:font-sans"
            />
          </div>
        ))}

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

      {/* ── Kalshi Live Trading ──────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Kalshi — Live Trading</h3>
            </div>
            <StatusBadge saved={savedProviders.has("kalshi_live")} />
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
            {kalshiSaveStatus === "success" ? "Kalshi credentials saved — configured" :
             kalshiSaveStatus === "error" ? "Save failed" :
             "Save Kalshi Keys"}
          </Button>
          {kalshiSaveError && (
            <p className="mt-2 text-[11px] text-loss flex items-center gap-1">
              <AlertCircle className="h-3 w-3 shrink-0" />
              {kalshiSaveError}
            </p>
          )}
        </div>
      </div>

      {/* ── Notifications ────────────────────────────────────────── */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Notifications</h3>
            <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Saved automatically</span>
          </div>
        </div>
        <div className="px-6 py-2">
          {[
            { key: "tradeExecuted",  label: "Trade Executed",      desc: "Alert when the agent enters a position" },
            { key: "positionClosed", label: "Position Closed",     desc: "Alert when a position settles or is exited" },
            { key: "stopLossHit",    label: "Stop Loss Triggered",  desc: "Alert when a position is force-closed by risk limits" },
            { key: "dailySummary",   label: "Daily Summary",        desc: "End-of-day recap of P&L and agent decisions" },
            { key: "agentAlerts",    label: "Agent Alerts",         desc: "Strategy suspensions, memory updates, anomalies" },
          ].map((item, i, arr) => (
            <div key={item.key} className={`flex items-center justify-between py-4 ${i < arr.length - 1 ? "border-b border-border/50" : ""}`}>
              <div>
                <Label className="text-sm font-medium">{item.label}</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">{item.desc}</p>
              </div>
              <Switch
                checked={notifications[item.key as keyof typeof notifications]}
                onCheckedChange={(val) => updateNotif(item.key, val)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
