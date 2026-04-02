import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Save, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export function SettingsPanel() {
  const [apiKeys, setApiKeys] = useState({
    kalshi_key_id: "",
    kalshi_private_key: "",
    openrouter: "",
    openai: "",
    anthropic: "",
    google: "",
  });
  const [notifications, setNotifications] = useState({
    tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
  });
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500],
    maxDrawdown: [20],
    maxPositionSize: [500],
    maxOpenPositions: [10],
    autoStopLoss: true,
    stopLossPct: [15],
    defaultOrderType: "limit",
  });
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [riskSaving, setRiskSaving] = useState(false);

  // Load risk settings from DB
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
    loadRiskSettings();
  }, [loadRiskSettings]);

  const handleSaveApiKeys = async () => {
    setSaving(true);
    setSaveStatus("idle");
    try {
      // Save each non-empty key
      const keysToSave = [
        { provider: "kalshi", key_id: apiKeys.kalshi_key_id, encrypted_secret: apiKeys.kalshi_private_key },
        { provider: "openrouter", key_id: "default", encrypted_secret: apiKeys.openrouter },
        { provider: "openai", key_id: "default", encrypted_secret: apiKeys.openai },
        { provider: "anthropic", key_id: "default", encrypted_secret: apiKeys.anthropic },
        { provider: "google", key_id: "default", encrypted_secret: apiKeys.google },
      ].filter(k => k.encrypted_secret);

      for (const key of keysToSave) {
        await supabase.from("api_keys").upsert(
          { ...key, updated_at: new Date().toISOString() },
          { onConflict: "provider" }
        );
      }

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
      const { data: existing } = await supabase.from("risk_settings").select("id").single();

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
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage Kalshi API connections, risk limits, and preferences.</p>
      </div>

      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">API Connections</h3>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">Kalshi API Key ID</Label>
          <Input
            type="password"
            value={apiKeys.kalshi_key_id}
            onChange={(e) => setApiKeys(prev => ({ ...prev, kalshi_key_id: e.target.value }))}
            placeholder="your-kalshi-api-key-id"
            className="rounded-xl border-0 bg-secondary text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">Kalshi Private Key</Label>
          <Input
            type="password"
            value={apiKeys.kalshi_private_key}
            onChange={(e) => setApiKeys(prev => ({ ...prev, kalshi_private_key: e.target.value }))}
            placeholder="your-kalshi-private-key"
            className="rounded-xl border-0 bg-secondary text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Generate API keys at kalshi.com/account/api-keys. Keep your private key secure.</p>
        </div>

        {[
          { key: "openrouter", label: "OpenRouter API Key", placeholder: "sk-or-..." },
          { key: "openai", label: "OpenAI API Key", placeholder: "sk-..." },
          { key: "anthropic", label: "Anthropic API Key", placeholder: "sk-ant-..." },
          { key: "google", label: "Google AI API Key", placeholder: "AIza..." },
        ].map((item) => (
          <div key={item.key} className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">{item.label}</Label>
            <Input
              type="password"
              value={apiKeys[item.key as keyof typeof apiKeys]}
              onChange={(e) => setApiKeys(prev => ({ ...prev, [item.key]: e.target.value }))}
              placeholder={item.placeholder}
              className="rounded-xl border-0 bg-secondary text-sm"
            />
          </div>
        ))}

        <Button className="w-full rounded-full gap-2 text-sm mt-2" onClick={handleSaveApiKeys} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> :
           saveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
           saveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
           <Save className="h-4 w-4" />}
          {saveStatus === "success" ? "Saved" : saveStatus === "error" ? "Error" : "Save API Keys"}
        </Button>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
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

        <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Risk Management (Enforced)</h3>
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
          <p className="text-[10px] text-muted-foreground">These limits are enforced server-side on every trade execution.</p>
        </div>
      </div>
    </div>
  );
}
