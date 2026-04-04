import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Save, Loader2, CheckCircle, AlertCircle, Circle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

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

  const [notifications, setNotifications] = useState({
    tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
  });
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500], maxDrawdown: [20], maxPositionSize: [500],
    maxOpenPositions: [10], autoStopLoss: true, stopLossPct: [15], defaultOrderType: "limit",
  });
  const [riskSaving, setRiskSaving] = useState(false);

  const loadSavedKeys = useCallback(async () => {
    const { data } = await supabase.from("api_keys").select("provider, key_id");
    if (data) {
      setSavedProviders(new Set(data.map(r => r.provider)));
      const kalshi = data.find(r => r.provider === "kalshi_live");
      if (kalshi) setKalshiLive(prev => ({ ...prev, key_id: kalshi.key_id }));
    }
  }, []);

  const loadRiskSettings = useCallback(async () => {
    const { data } = await supabase.from("risk_settings").select("*").single();
    if (data) {
      setRiskSettings({
        maxDailyLoss: [data.max_daily_loss],
        maxDrawdown: [data.max_drawdown_pct],
        maxPositionSize: [data.max_position_size],
        maxOpenPositions: [data.max_open_positions],
        autoStopLoss: data.auto_stop_loss,
        stopLossPct: [data.stop_loss_pct],
        defaultOrderType: data.default_order_type,
      });
    }
  }, []);

  useEffect(() => {
    loadSavedKeys();
    loadRiskSettings();
  }, [loadSavedKeys, loadRiskSettings]);

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
      await supabase.from("api_keys").upsert(
        { provider: "kalshi_live", key_id: kalshiLive.key_id, encrypted_secret: kalshiLive.private_key, updated_at: new Date().toISOString() },
        { onConflict: "provider" }
      );
      await loadSavedKeys();
      setKalshiSaveStatus("success");
      setTimeout(() => setKalshiSaveStatus("idle"), 3000);
    } catch {
      setKalshiSaveStatus("error");
    } finally {
      setKalshiSaving(false);
    }
  };

  const handleSaveRiskSettings = async () => {
    setRiskSaving(true);
    try {
      const payload = {
        max_daily_loss: riskSettings.maxDailyLoss[0],
        max_drawdown_pct: riskSettings.maxDrawdown[0],
        max_position_size: riskSettings.maxPositionSize[0],
        max_open_positions: riskSettings.maxOpenPositions[0],
        auto_stop_loss: riskSettings.autoStopLoss,
        stop_loss_pct: riskSettings.stopLossPct[0],
        default_order_type: riskSettings.defaultOrderType,
        updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase.from("risk_settings").select("id").single();
      if (existing) {
        await supabase.from("risk_settings").update(payload).eq("id", existing.id);
      } else {
        await supabase.from("risk_settings").insert(payload);
      }
    } catch (e) {
      console.error("Failed to save risk settings:", e);
    } finally {
      setRiskSaving(false);
    }
  };

  return (
    <div className="space-y-8 apple-reveal">
      <div>
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">API keys are stored securely in your database and used by the agent and trading engine.</p>
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

      <div className="grid md:grid-cols-2 gap-6">
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

        {/* ── Risk Management ─────────────────────────────────────── */}
        <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Risk Management</h3>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Max Daily Loss</Label>
              <span className="text-sm">${riskSettings.maxDailyLoss[0]}</span>
            </div>
            <Slider value={riskSettings.maxDailyLoss} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxDailyLoss: v }))} max={5000} step={50} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Max Drawdown</Label>
              <span className="text-sm">{riskSettings.maxDrawdown[0]}%</span>
            </div>
            <Slider value={riskSettings.maxDrawdown} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxDrawdown: v }))} max={50} step={1} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Max Position Size</Label>
              <span className="text-sm">${riskSettings.maxPositionSize[0]}</span>
            </div>
            <Slider value={riskSettings.maxPositionSize} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxPositionSize: v }))} max={5000} step={50} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Max Open Positions</Label>
              <span className="text-sm">{riskSettings.maxOpenPositions[0]}</span>
            </div>
            <Slider value={riskSettings.maxOpenPositions} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxOpenPositions: v }))} max={50} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm">Auto Stop-Loss ({riskSettings.stopLossPct[0]}%)</Label>
            <Switch checked={riskSettings.autoStopLoss} onCheckedChange={(checked) => setRiskSettings(prev => ({ ...prev, autoStopLoss: checked }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Default Order Type</Label>
            <Select value={riskSettings.defaultOrderType} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, defaultOrderType: v }))}>
              <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="limit">Limit</SelectItem>
                <SelectItem value="market">Market</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full rounded-full gap-2 text-sm" onClick={handleSaveRiskSettings} disabled={riskSaving}>
            {riskSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Risk Settings
          </Button>
          <p className="text-[10px] text-muted-foreground">Enforced server-side on every trade execution.</p>
        </div>
      </div>
    </div>
  );
}
