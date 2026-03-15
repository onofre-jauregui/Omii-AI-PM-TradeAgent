import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Save } from "lucide-react";
import { useState } from "react";

export function SettingsPanel() {
  const [apiKeys, setApiKeys] = useState({
    polymarket: "", openrouter: "", openai: "", anthropic: "", google: "",
  });
  const [notifications, setNotifications] = useState({
    tradeExecuted: true, positionClosed: true, stopLossHit: true, dailySummary: false, agentAlerts: true,
  });
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500], maxDrawdown: [20], autoStopLoss: true, defaultCurrency: "USD",
  });

  return (
    <div className="space-y-8 apple-reveal">
      <div>
        <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage API connections and trading preferences.</p>
      </div>

      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-5">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">API Connections</h3>
        </div>
        {[
          { key: "polymarket", label: "Polymarket API Key", placeholder: "poly_..." },
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
        <Button className="w-full rounded-full gap-2 text-sm mt-2">
          <Save className="h-4 w-4" /> Save API Keys
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
            <h3 className="text-sm font-medium text-muted-foreground">Risk & Trading</h3>
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
          <div className="flex items-center justify-between">
            <Label className="text-sm">Auto Stop-Loss</Label>
            <Switch checked={riskSettings.autoStopLoss} onCheckedChange={(checked) => setRiskSettings(prev => ({ ...prev, autoStopLoss: checked }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Currency</Label>
            <Select value={riskSettings.defaultCurrency} onValueChange={(v) => setRiskSettings(prev => ({ ...prev, defaultCurrency: v }))}>
              <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
