import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Save, Loader2, CheckCircle, AlertCircle, Circle, Info } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

// Status dot for each key
function KeyStatus({ saved }: { saved: boolean }) {
  return saved
    ? <CheckCircle className="h-3.5 w-3.5 text-profit shrink-0" />
    : <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />;
}

export function SettingsPanel() {
  // Kalshi live trading keys (for real money)
  const [kalshiLive, setKalshiLive] = useState({ key_id: "", private_key: "" });
  // AI provider keys (only one needed — OpenRouter covers all models)
  const [aiKeys, setAiKeys] = useState({ openrouter: "", openai: "", anthropic: "", google: "" });

  const [savedProviders, setSavedProviders] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const [notifications, setNotifications] = useState({
    tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
  });
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500], maxDrawdown: [20], maxPositionSize: [500],
    maxOpenPositions: [10], autoStopLoss: true, stopLossPct: [15], defaultOrderType: "limit",
  });
  const [riskSaving, setRiskSaving] = useState(false);

  // Load which providers already have keys saved
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

  const handleSaveApiKeys = async () => {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const keysToSave = [
        // Kalshi live — only save if both fields filled
        kalshiLive.key_id && kalshiLive.private_key
          ? { provider: "kalshi_live", key_id: kalshiLive.key_id, encrypted_secret: kalshiLive.private_key }
          : null,
        aiKeys.openrouter
          ? { provider: "openrouter", key_id: "default", encrypted_secret: aiKeys.openrouter }
          : null,
        aiKeys.openai
          ? { provider: "openai", key_id: "default", encrypted_secret: aiKeys.openai }
          : null,
        aiKeys.anthropic
          ? { provider: "anthropic", key_id: "default", encrypted_secret: aiKeys.anthropic }
          : null,
        aiKeys.google
          ? { provider: "google", key_id: "default", encrypted_secret: aiKeys.google }
          : null,
      ].filter(Boolean) as { provider: string; key_id: string; encrypted_secret: string }[];

      for (const key of keysToSave) {
        await supabase.from("api_keys").upsert(
          { ...key, updated_at: new Date().toISOString() },
          { onConflict: "provider" }
        );
      }

      await loadSavedKeys();
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
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
        <p className="text-sm text-muted-foreground mt-1">API keys are stored in your database and used by the trading engine automatically.</p>
      </div>

      {/* ── Kalshi Live Trading ─────────────────────────────────── */}
      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Kalshi — Live Trading</h3>
            <KeyStatus saved={savedProviders.has("kalshi_live")} />
          </div>
          <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Real money only</span>
        </div>

        <div className="rounded-xl bg-secondary/50 px-4 py-3 flex gap-2">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Paper trading works without these keys</strong> — real live market prices are fetched from Kalshi's public API automatically.
            Only add these when you're ready to trade with real money. Fund your account at kalshi.com first.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">API Key ID</Label>
          <Input
            type="password"
            value={kalshiLive.key_id}
            onChange={(e) => setKalshiLive(prev => ({ ...prev, key_id: e.target.value }))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="rounded-xl border-0 bg-secondary text-sm font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">RSA Private Key</Label>
          <textarea
            value={kalshiLive.private_key}
            onChange={(e) => setKalshiLive(prev => ({ ...prev, private_key: e.target.value }))}
            placeholder={"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"}
            className="w-full rounded-xl border-0 bg-secondary text-xs font-mono p-3 min-h-[100px] resize-y text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <p className="text-[10px] text-muted-foreground">
            Generated at kalshi.com → Account → API Keys. The private key signs each request — it never leaves your server.
          </p>
        </div>
      </div>

      {/* ── AI Provider Keys ────────────────────────────────────── */}
      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">AI Model Keys</h3>
            <KeyStatus saved={savedProviders.has("openrouter") || savedProviders.has("openai") || savedProviders.has("anthropic")} />
          </div>
          <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Required for agent</span>
        </div>

        <div className="rounded-xl bg-secondary/50 px-4 py-3 flex gap-2">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">OpenRouter is recommended</strong> — one key gives you access to GPT-4, Gemini, Claude, and more.
            Get one at openrouter.ai for ~$5. Or use a direct provider key below.
          </p>
        </div>

        {[
          { key: "openrouter" as const, label: "OpenRouter API Key", placeholder: "sk-or-v1-...", recommended: true },
          { key: "openai" as const, label: "OpenAI API Key", placeholder: "sk-proj-...", recommended: false },
          { key: "anthropic" as const, label: "Anthropic API Key", placeholder: "sk-ant-api03-...", recommended: false },
          { key: "google" as const, label: "Google AI API Key", placeholder: "AIzaSy...", recommended: false },
        ].map((item) => (
          <div key={item.key} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">{item.label}</Label>
              <KeyStatus saved={savedProviders.has(item.key)} />
              {item.recommended && (
                <span className="text-[9px] text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Recommended</span>
              )}
            </div>
            <Input
              type="password"
              value={aiKeys[item.key]}
              onChange={(e) => setAiKeys(prev => ({ ...prev, [item.key]: e.target.value }))}
              placeholder={item.placeholder}
              className="rounded-xl border-0 bg-secondary text-sm font-mono"
            />
          </div>
        ))}

        <Button
          className="w-full rounded-full gap-2 text-sm mt-2"
          onClick={handleSaveApiKeys}
          disabled={saving}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> :
           saveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
           saveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
           <Save className="h-4 w-4" />}
          {saveStatus === "success" ? "Saved — engine will use these keys" :
           saveStatus === "error" ? "Save failed — try again" :
           "Save API Keys"}
        </Button>
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
