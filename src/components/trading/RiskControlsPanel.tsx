import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Shield, Save, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export function RiskControlsPanel() {
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss: [500], maxDrawdown: [20], maxPositionSize: [500],
    maxOpenPositions: [10], autoStopLoss: true, stopLossPct: [15], defaultOrderType: "limit",
  });
  const [riskSaving, setRiskSaving] = useState(false);
  const [riskSaveStatus, setRiskSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const loadRiskSettings = useCallback(async () => {
    const { data } = await supabase.from("risk_settings").select("*").single();
    if (data) {
      setRiskSettings({
        maxDailyLoss:     [data.max_daily_loss],
        maxDrawdown:      [data.max_drawdown_pct],
        maxPositionSize:  [data.max_position_size],
        maxOpenPositions: [data.max_open_positions],
        autoStopLoss:     data.auto_stop_loss,
        stopLossPct:      [data.stop_loss_pct],
        defaultOrderType: data.default_order_type,
      });
    }
  }, []);

  const handleSave = async () => {
    setRiskSaving(true);
    setRiskSaveStatus("idle");
    try {
      const payload = {
        max_daily_loss:    riskSettings.maxDailyLoss[0],
        max_drawdown_pct:  riskSettings.maxDrawdown[0],
        max_position_size: riskSettings.maxPositionSize[0],
        max_open_positions:riskSettings.maxOpenPositions[0],
        auto_stop_loss:    riskSettings.autoStopLoss,
        stop_loss_pct:     riskSettings.stopLossPct[0],
        default_order_type:riskSettings.defaultOrderType,
        updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase.from("risk_settings").select("id").single();
      if (existing) {
        await supabase.from("risk_settings").update(payload).eq("id", existing.id);
      } else {
        await supabase.from("risk_settings").insert(payload);
      }
      setRiskSaveStatus("success");
      setTimeout(() => setRiskSaveStatus("idle"), 3000);
    } catch {
      setRiskSaveStatus("error");
      setTimeout(() => setRiskSaveStatus("idle"), 3000);
    } finally {
      setRiskSaving(false);
    }
  };

  useEffect(() => { loadRiskSettings(); }, [loadRiskSettings]);

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden apple-reveal">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Risk Controls</h3>
        <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full ml-auto">
          Enforced server-side on every trade
        </span>
      </div>

      <div className="px-5 py-5 space-y-5">
        <div className="grid sm:grid-cols-2 gap-6">
          <div className="space-y-5">
            {[
              { label: "Max Daily Loss",    value: `$${riskSettings.maxDailyLoss[0]}`,    key: "maxDailyLoss",    max: 5000, step: 50 },
              { label: "Max Drawdown",      value: `${riskSettings.maxDrawdown[0]}%`,      key: "maxDrawdown",     max: 50,   step: 1  },
              { label: "Max Position Size", value: `$${riskSettings.maxPositionSize[0]}`,  key: "maxPositionSize", max: 5000, step: 50 },
            ].map(({ label, value, key, max, step }) => (
              <div key={key} className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-sm text-muted-foreground">{label}</Label>
                  <span className="text-sm font-medium tabular-nums">{value}</span>
                </div>
                <Slider
                  value={riskSettings[key as keyof typeof riskSettings] as number[]}
                  onValueChange={(v) => setRiskSettings(prev => ({ ...prev, [key]: v }))}
                  max={max} step={step}
                />
              </div>
            ))}
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-sm text-muted-foreground">Max Open Positions</Label>
                <span className="text-sm font-medium tabular-nums">{riskSettings.maxOpenPositions[0]}</span>
              </div>
              <Slider
                value={riskSettings.maxOpenPositions}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxOpenPositions: v }))}
                max={50} step={1}
              />
            </div>
            <div className="flex items-center justify-between py-1">
              <div>
                <Label className="text-sm">Auto Stop-Loss</Label>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Exit position at {riskSettings.stopLossPct[0]}% loss
                </p>
              </div>
              <Switch
                checked={riskSettings.autoStopLoss}
                onCheckedChange={(checked) => setRiskSettings(prev => ({ ...prev, autoStopLoss: checked }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Default Order Type</Label>
              <Select
                value={riskSettings.defaultOrderType}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, defaultOrderType: v }))}
              >
                <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="limit">Limit — better fills, requires patience</SelectItem>
                  <SelectItem value="market">Market — instant fill, accepts spread</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 pb-5">
        <Button className="rounded-full gap-2 text-sm" onClick={handleSave} disabled={riskSaving}>
          {riskSaving          ? <Loader2 className="h-4 w-4 animate-spin" /> :
           riskSaveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
           riskSaveStatus === "error"   ? <AlertCircle className="h-4 w-4" /> :
           <Save className="h-4 w-4" />}
          {riskSaveStatus === "success" ? "Saved"
           : riskSaveStatus === "error" ? "Save failed"
           : "Save Risk Settings"}
        </Button>
      </div>
    </div>
  );
}
