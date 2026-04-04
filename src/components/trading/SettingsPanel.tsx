import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Save, Loader2, CheckCircle, AlertCircle, Circle, Info, Cpu, RefreshCw } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface AIModel {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
}

const LIST_MODELS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/list-ai-models`;

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

  // Model preferences
  const [availableModels, setAvailableModels] = useState<AIModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const [agentModel, setAgentModel] = useState("");
  const [tradingModel, setTradingModel] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveStatus, setModelSaveStatus] = useState<"idle" | "success" | "error">("idle");

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

  const loadModelPreferences = useCallback(async () => {
    const { data } = await supabase
      .from("api_keys")
      .select("provider, key_id")
      .in("provider", ["model_agent", "model_trading"]);
    if (data) {
      const agent = data.find(r => r.provider === "model_agent");
      const trading = data.find(r => r.provider === "model_trading");
      if (agent?.key_id) setAgentModel(agent.key_id);
      if (trading?.key_id) setTradingModel(trading.key_id);
    }
  }, []);

  const fetchAvailableModels = useCallback(async () => {
    setFetchingModels(true);
    setFetchModelsError(null);
    try {
      const res = await fetch(LIST_MODELS_URL, {
        headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}` },
      });
      const data = await res.json();
      if (data.models?.length > 0) {
        setAvailableModels(data.models);
      } else {
        setFetchModelsError(data.error || "No models returned. Make sure you have saved an AI API key.");
      }
    } catch (e: any) {
      setFetchModelsError("Failed to reach the model list service.");
    } finally {
      setFetchingModels(false);
    }
  }, []);

  const saveModelPreferences = async () => {
    setModelSaving(true);
    setModelSaveStatus("idle");
    try {
      const prefs = [
        agentModel ? { provider: "model_agent", key_id: agentModel, encrypted_secret: agentModel } : null,
        tradingModel ? { provider: "model_trading", key_id: tradingModel, encrypted_secret: tradingModel } : null,
      ].filter(Boolean) as { provider: string; key_id: string; encrypted_secret: string }[];
      for (const pref of prefs) {
        await supabase.from("api_keys").upsert(
          { ...pref, updated_at: new Date().toISOString() },
          { onConflict: "provider" }
        );
      }
      setModelSaveStatus("success");
      setTimeout(() => setModelSaveStatus("idle"), 3000);
    } catch {
      setModelSaveStatus("error");
    } finally {
      setModelSaving(false);
    }
  };

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
    loadModelPreferences();
  }, [loadSavedKeys, loadRiskSettings, loadModelPreferences]);

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

      {/* ── Model Preferences ───────────────────────────────────── */}
      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Model Preferences</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchAvailableModels}
            disabled={fetchingModels}
            className="rounded-full text-xs gap-1.5 h-7 px-3"
          >
            {fetchingModels
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <RefreshCw className="h-3 w-3" />}
            {fetchingModels ? "Fetching…" : availableModels.length > 0 ? "Refresh Models" : "Fetch Available Models"}
          </Button>
        </div>

        {fetchModelsError && (
          <div className="flex items-start gap-2 rounded-xl bg-loss/10 px-4 py-3">
            <AlertCircle className="h-3.5 w-3.5 text-loss shrink-0 mt-0.5" />
            <p className="text-xs text-loss">{fetchModelsError}</p>
          </div>
        )}

        {availableModels.length === 0 && !fetchModelsError ? (
          <p className="text-xs text-muted-foreground">
            Save an API key above, then click <span className="font-medium text-foreground">Fetch Available Models</span> to see all models you have access to.
          </p>
        ) : availableModels.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {availableModels.length} models available from your saved provider keys.
            </p>

            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Agent Chat Model</Label>
              <Select value={agentModel} onValueChange={setAgentModel}>
                <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                  <SelectValue placeholder="Select a model…" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <div className="flex flex-col gap-0.5 py-0.5">
                        <span className="text-sm">{m.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{m.id}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">Used in the Agent tab when you chat interactively.</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Auto-Trading Model</Label>
              <Select value={tradingModel} onValueChange={setTradingModel}>
                <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                  <SelectValue placeholder="Select a model…" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <div className="flex flex-col gap-0.5 py-0.5">
                        <span className="text-sm">{m.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{m.id}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">Used when strategies run autonomously. Pick a fast, cost-effective model.</p>
            </div>

            <Button
              className="w-full rounded-full gap-2 text-sm"
              onClick={saveModelPreferences}
              disabled={modelSaving || (!agentModel && !tradingModel)}
            >
              {modelSaving ? <Loader2 className="h-4 w-4 animate-spin" /> :
               modelSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
               modelSaveStatus === "error" ? <AlertCircle className="h-4 w-4" /> :
               <Save className="h-4 w-4" />}
              {modelSaveStatus === "success" ? "Model preferences saved" :
               modelSaveStatus === "error" ? "Save failed — try again" :
               "Save Model Preferences"}
            </Button>
          </>
        )}
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
