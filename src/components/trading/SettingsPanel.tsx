import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Key, Bell, Shield, Globe, Wallet, Save } from "lucide-react";
import { useState } from "react";

export function SettingsPanel() {
  const [apiKeys, setApiKeys] = useState({
    polymarket: "",
    openrouter: "",
    openai: "",
    anthropic: "",
    google: "",
  });
  const [notifications, setNotifications] = useState({
    tradeExecuted: true,
    positionClosed: true,
    stopLossHit: true,
    dailySummary: false,
    agentAlerts: true,
  });
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500],
    maxDrawdown: [20],
    autoStopLoss: true,
    defaultCurrency: "USD",
  });

  return (
    <div className="space-y-6 animate-slide-up">
      {/* API Keys */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
            <Key className="h-4 w-4" /> API CONNECTIONS
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { key: "polymarket", label: "POLYMARKET API KEY", placeholder: "poly_..." },
            { key: "openrouter", label: "OPENROUTER API KEY", placeholder: "sk-or-..." },
            { key: "openai", label: "OPENAI API KEY", placeholder: "sk-..." },
            { key: "anthropic", label: "ANTHROPIC API KEY", placeholder: "sk-ant-..." },
            { key: "google", label: "GOOGLE AI API KEY", placeholder: "AIza..." },
          ].map((item) => (
            <div key={item.key} className="space-y-1.5">
              <Label className="text-xs font-mono text-muted-foreground">{item.label}</Label>
              <Input
                type="password"
                value={apiKeys[item.key as keyof typeof apiKeys]}
                onChange={(e) => setApiKeys(prev => ({ ...prev, [item.key]: e.target.value }))}
                placeholder={item.placeholder}
                className="bg-secondary border-border font-mono text-sm"
              />
            </div>
          ))}
          <Button className="w-full font-mono text-xs gap-2 mt-2">
            <Save className="h-4 w-4" /> SAVE API KEYS
          </Button>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Notifications */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <Bell className="h-4 w-4" /> NOTIFICATIONS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { key: "tradeExecuted", label: "Trade Executed" },
              { key: "positionClosed", label: "Position Closed" },
              { key: "stopLossHit", label: "Stop Loss Triggered" },
              { key: "dailySummary", label: "Daily Summary" },
              { key: "agentAlerts", label: "Agent Alerts" },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between">
                <Label className="text-sm font-mono">{item.label}</Label>
                <Switch
                  checked={notifications[item.key as keyof typeof notifications]}
                  onCheckedChange={(checked) =>
                    setNotifications(prev => ({ ...prev, [item.key]: checked }))
                  }
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Risk & Trading */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <Shield className="h-4 w-4" /> RISK & TRADING
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-xs font-mono text-muted-foreground">MAX DAILY LOSS</Label>
                <span className="text-xs font-mono text-foreground">${riskSettings.maxDailyLoss[0]}</span>
              </div>
              <Slider
                value={riskSettings.maxDailyLoss}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxDailyLoss: v }))}
                max={5000}
                step={50}
              />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-xs font-mono text-muted-foreground">MAX DRAWDOWN %</Label>
                <span className="text-xs font-mono text-foreground">{riskSettings.maxDrawdown[0]}%</span>
              </div>
              <Slider
                value={riskSettings.maxDrawdown}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxDrawdown: v }))}
                max={50}
                step={1}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm font-mono">Auto Stop-Loss</Label>
              <Switch
                checked={riskSettings.autoStopLoss}
                onCheckedChange={(checked) =>
                  setRiskSettings(prev => ({ ...prev, autoStopLoss: checked }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-mono text-muted-foreground">DEFAULT CURRENCY</Label>
              <Select
                value={riskSettings.defaultCurrency}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, defaultCurrency: v }))}
              >
                <SelectTrigger className="bg-secondary border-border font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="USDC">USDC</SelectItem>
                  <SelectItem value="ETH">ETH</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
