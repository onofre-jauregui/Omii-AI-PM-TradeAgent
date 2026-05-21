import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Shield, Save, Loader2, CheckCircle, AlertCircle, Wallet, OctagonX, Play } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useStrategies } from "@/lib/strategiesContext";

export function RiskControlsPanel() {
  const { strategies } = useStrategies();
  const activeStrategies = strategies.filter(s => s.active);

  const [totalBudget, setTotalBudget] = useState<string>("3000");
  const [allocations, setAllocations] = useState<Record<string, number>>({}); // strategy id → % (0-100)
  const [riskSettings, setRiskSettings] = useState({
    maxDailyLoss:     [500],
    maxDrawdown:      [20],
    maxPositionSize:  [500],
    maxOpenPositions: [10],
    maxDailyTrades:   [30],
    autoStopLoss:     true,
    stopLossPct:      [15],
    defaultOrderType: "limit",
  });
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Global kill switch state
  const [isHalted, setIsHalted] = useState(false);
  const [haltReason, setHaltReason] = useState<string | null>(null);
  const [riskStateId, setRiskStateId] = useState<string | null>(null);
  const [haltToggling, setHaltToggling] = useState(false);

  const loadRiskState = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from("risk_state")
      .select("id, is_trading_halted, halt_reason")
      .eq("date", today)
      .maybeSingle();
    if (data) {
      setIsHalted(data.is_trading_halted ?? false);
      setHaltReason(data.halt_reason ?? null);
      setRiskStateId(data.id);
    }
  }, []);

  const handleToggleHalt = async () => {
    setHaltToggling(true);
    const today = new Date().toISOString().slice(0, 10);
    const next = !isHalted;
    const payload = {
      is_trading_halted: next,
      halt_reason: next ? "Manually paused by user" : null,
      updated_at: new Date().toISOString(),
    };
    if (riskStateId) {
      await supabase.from("risk_state").update(payload).eq("id", riskStateId);
    } else {
      // No row for today yet — insert one
      const { data } = await supabase.from("risk_state").insert({ ...payload, date: today }).select("id").single();
      if (data) setRiskStateId(data.id);
    }
    setIsHalted(next);
    setHaltReason(next ? "Manually paused by user" : null);
    setHaltToggling(false);
  };

  const loadAll = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? "";
    const { data } = await supabase.from("risk_settings").select("*")
      .eq("user_id", userId).maybeSingle();
    if (data) {
      setRiskSettings({
        maxDailyLoss:     [data.max_daily_loss],
        maxDrawdown:      [data.max_drawdown_pct],
        maxPositionSize:  [data.max_position_size],
        maxOpenPositions: [data.max_open_positions],
        maxDailyTrades:   [data.max_daily_trades ?? 30],
        autoStopLoss:     data.auto_stop_loss,
        stopLossPct:      [data.stop_loss_pct],
        defaultOrderType: data.default_order_type,
      });
    }
  }, []);

  useEffect(() => { loadAll(); loadRiskState(); }, [loadAll, loadRiskState]);

  // Derive total budget + allocation % from per-strategy starting_balances on load
  useEffect(() => {
    if (strategies.length === 0) return;
    const total = strategies.reduce((s, st) => s + (st.starting_balance ?? 0), 0);
    if (total > 0) setTotalBudget(String(total));
    const pcts: Record<string, number> = {};
    for (const s of strategies) {
      pcts[s.id] = total > 0 ? Math.round(((s.starting_balance ?? 0) / total) * 100) : Math.round(100 / strategies.length);
    }
    setAllocations(pcts);
  }, [strategies]);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus("idle");
    try {
      // Save risk settings scoped to current user
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id ?? "";
      const riskPayload = {
        user_id:            userId,
        max_daily_loss:     riskSettings.maxDailyLoss[0],
        max_drawdown_pct:   riskSettings.maxDrawdown[0],
        max_position_size:  riskSettings.maxPositionSize[0],
        max_open_positions: riskSettings.maxOpenPositions[0],
        max_daily_trades:   riskSettings.maxDailyTrades[0],
        auto_stop_loss:     riskSettings.autoStopLoss,
        stop_loss_pct:      riskSettings.stopLossPct[0],
        default_order_type: riskSettings.defaultOrderType,
        updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase.from("risk_settings").select("id")
        .eq("user_id", userId).maybeSingle();
      if (existing) {
        await supabase.from("risk_settings").update(riskPayload).eq("id", existing.id);
      } else {
        await supabase.from("risk_settings").insert(riskPayload);
      }

      // Save per-strategy starting_balance = totalBudget × allocation%
      const total = Math.max(0, parseInt(totalBudget, 10) || 0);
      await Promise.all(
        Object.entries(allocations).map(([id, pct]) => {
          const amount = Math.round(total * (pct / 100));
          return supabase.from("strategies").update({ starting_balance: amount }).eq("id", id);
        })
      );

      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } finally {
      setSaving(false);
    }
  };

  const totalBudgetNum = Math.max(0, parseInt(totalBudget, 10) || 0);
  const totalAllocatedPct = Object.values(allocations).reduce((s, p) => s + p, 0);

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden apple-reveal">

      {/* ── Global Kill Switch ───────────────────────────── */}
      <div className={`px-5 py-4 border-b border-border transition-colors ${isHalted ? "bg-loss/8" : ""}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
              isHalted ? "bg-loss/15" : "bg-profit/15"
            }`}>
              {isHalted
                ? <OctagonX className="h-4 w-4 text-loss" />
                : <Play className="h-4 w-4 text-profit" />
              }
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {isHalted ? "Trading Paused" : "Agent Active"}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {isHalted
                  ? (haltReason ?? "All new trades blocked until resumed")
                  : "Agent is running — all strategies executing normally"}
              </p>
            </div>
          </div>
          <Button
            variant={isHalted ? "outline" : "destructive"}
            size="sm"
            className={`shrink-0 rounded-full gap-1.5 text-xs font-medium ${
              isHalted
                ? "border-profit text-profit hover:bg-profit/10"
                : "bg-loss hover:bg-loss/90 text-white border-0"
            }`}
            onClick={handleToggleHalt}
            disabled={haltToggling}
          >
            {haltToggling
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : isHalted
                ? <Play className="h-3.5 w-3.5" />
                : <OctagonX className="h-3.5 w-3.5" />
            }
            {isHalted ? "Resume Trading" : "Pause All Trading"}
          </Button>
        </div>
      </div>

      {/* ── Agent Budget ────────────────────────────────── */}
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Agent Budget</h3>
        <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full ml-auto">
          Starting capital reference for ROI tracking
        </span>
      </div>

      <div className="px-5 py-5 space-y-4 border-b border-border">
        {strategies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No strategies configured yet.</p>
        ) : (
          <>
            {/* Total budget */}
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Total Budget</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                <Input
                  type="number"
                  min={0}
                  step={500}
                  value={totalBudget}
                  onChange={(e) => setTotalBudget(e.target.value)}
                  className="pl-6 rounded-xl border-0 bg-secondary text-sm tabular-nums h-9"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Your Kalshi balance is the real constraint for live trades — this is the reference capital used for ROI and Kelly sizing. Revoke access anytime from <span className="font-medium">Kalshi → Account → API Keys</span>.
              </p>
            </div>

            {/* Per-strategy allocation % */}
            <div className="space-y-3 pt-1 border-t border-border">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Allocation per Strategy</Label>
              {strategies.map(s => {
                const pct = allocations[s.id] ?? 0;
                const dollars = Math.round(totalBudgetNum * (pct / 100));
                return (
                  <div key={s.id} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <span className="text-sm text-foreground">{s.name}</span>
                        <span className="ml-1.5 text-[11px] text-muted-foreground">{s.active ? "Active" : "Paused"}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-muted-foreground tabular-nums">${dollars.toLocaleString()}</span>
                        <span className="text-sm font-medium tabular-nums w-9 text-right">{pct}%</span>
                      </div>
                    </div>
                    <Slider
                      value={[pct]}
                      onValueChange={([v]) => setAllocations(prev => ({ ...prev, [s.id]: v }))}
                      min={0} max={100} step={5}
                    />
                  </div>
                );
              })}
              {totalAllocatedPct !== 100 && (
                <p className="text-[11px] text-warning">
                  Allocations total {totalAllocatedPct}% — adjust to reach 100% for accurate tracking.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Risk Controls ────────────────────────────────── */}
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
                max={100} step={1}
              />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-sm text-muted-foreground">Max Daily Trades</Label>
                <span className="text-sm font-medium tabular-nums">{riskSettings.maxDailyTrades[0]}</span>
              </div>
              <Slider
                value={riskSettings.maxDailyTrades}
                onValueChange={(v) => setRiskSettings(prev => ({ ...prev, maxDailyTrades: v }))}
                min={5} max={200} step={5}
              />
              <p className="text-[10px] text-muted-foreground">Global cap across all strategies — agent allocates the budget</p>
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
        <Button className="rounded-full gap-2 text-sm" onClick={handleSave} disabled={saving}>
          {saving             ? <Loader2 className="h-4 w-4 animate-spin" /> :
           saveStatus === "success" ? <CheckCircle className="h-4 w-4" /> :
           saveStatus === "error"   ? <AlertCircle className="h-4 w-4" /> :
           <Save className="h-4 w-4" />}
          {saveStatus === "success" ? "Saved"
           : saveStatus === "error" ? "Save failed"
           : "Save Budget & Risk"}
        </Button>
      </div>
    </div>
  );
}
