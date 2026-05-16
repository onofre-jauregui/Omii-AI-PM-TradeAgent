import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Plus, Pencil, Trash2, BookOpen, Save, X,
  TrendingUp, TrendingDown, BarChart3, Target, DollarSign, Loader2, Wallet,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useStrategies, type Strategy } from "@/lib/strategiesContext";
import { supabase } from "@/integrations/supabase/client";

function BudgetSummary({ strategies }: { strategies: Strategy[] }) {
  const [perTradeMax, setPerTradeMax] = useState<number | null>(null);

  useEffect(() => {
    supabase.from("risk_settings").select("max_position_size").single()
      .then(({ data }) => { if (data) setPerTradeMax(data.max_position_size); });
  }, []);

  const active = strategies.filter(s => s.active);
  const totalAllocated = active.reduce((sum, s) => sum + (s.starting_balance ?? 0), 0);

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Agent Budget</h3>
        <span className="text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full ml-auto">
          Soft limits · enforced by risk engine
        </span>
      </div>
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Total allocated</span>
          <span className="text-sm font-semibold tabular-nums">
            ${totalAllocated.toLocaleString("en-US", { minimumFractionDigits: 0 })}
          </span>
        </div>
        {perTradeMax !== null && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Per-trade max</span>
            <span className="text-sm font-medium tabular-nums text-muted-foreground">
              ${perTradeMax.toLocaleString("en-US", { minimumFractionDigits: 0 })}
            </span>
          </div>
        )}
        {active.length > 0 && (
          <div className="pt-1 space-y-1.5 border-t border-border">
            {active.map(s => (
              <div key={s.id} className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{s.name}</span>
                <span className="text-xs tabular-nums">
                  ${(s.starting_balance ?? 0).toLocaleString("en-US", { minimumFractionDigits: 0 })}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground pt-1">
          Your Kalshi balance is separate — the agent only uses what you allocate here.
          Revoke access anytime from <span className="font-medium">Kalshi → Account → API Keys</span>.
        </p>
      </div>
    </div>
  );
}
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

// ─── Strategy detail chart ────────────────────────────────────────────────────
function StrategyDetailModal({
  strategy,
  onClose,
  onEdit,
}: {
  strategy: Strategy;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { strategyStats } = useStrategies();
  const stats = strategyStats[strategy.id];
  const pnl = stats?.totalPnl ?? 0;
  const roi = stats?.roi ?? 0;
  const balance = stats?.balance ?? strategy.starting_balance;

  const [chartData, setChartData] = useState<{ date: string; balance: number }[]>([]);
  const [loadingChart, setLoadingChart] = useState(true);

  const buildChart = useCallback(async () => {
    setLoadingChart(true);
    const { data: trades } = await supabase
      .from("trades")
      .select("strategy, strategy_id, pnl, created_at, status")
      .eq("status", "filled")
      .order("created_at", { ascending: true });

    if (!trades || trades.length === 0) {
      setChartData([{ date: "Start", balance: strategy.starting_balance }]);
      setLoadingChart(false);
      return;
    }

    const relevant = trades.filter(
      t => t.strategy_id === strategy.id || t.strategy === strategy.name || t.strategy === strategy.id
    );

    let running = strategy.starting_balance;
    const points: { date: string; balance: number }[] = [
      { date: "Start", balance: running },
    ];

    const dayMap = new Map<string, typeof trades>();
    for (const t of relevant) {
      const day = new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day)!.push(t);
    }

    for (const [day, dayTrades] of dayMap) {
      for (const t of dayTrades) running += t.pnl || 0;
      points.push({ date: day, balance: Math.round(running * 100) / 100 });
    }

    setChartData(points);
    setLoadingChart(false);
  }, [strategy]);

  useEffect(() => { buildChart(); }, [buildChart]);

  const isProfit = pnl >= 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-0 apple-shadow max-w-xl p-0 overflow-hidden">
        <div className="p-6 space-y-5">
          <DialogHeader>
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="secondary" className="text-[10px] rounded-full font-mono px-2">{strategy.id}</Badge>
              <Badge variant="secondary" className={`text-[10px] rounded-full ${
                strategy.mode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"
              }`}>{strategy.mode}</Badge>
              {strategy.active && (
                <Badge variant="secondary" className="text-[10px] rounded-full bg-profit/10 text-profit">Active</Badge>
              )}
            </div>
            <DialogTitle className="text-lg font-medium">{strategy.name}</DialogTitle>
            {strategy.description && (
              <p className="text-sm text-muted-foreground leading-relaxed">{strategy.description}</p>
            )}
          </DialogHeader>

          {/* Stats row */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "Balance", value: `$${Math.round(balance).toLocaleString()}`, icon: DollarSign, cls: "" },
              { label: "P&L", value: `${isProfit ? "+" : ""}$${pnl.toFixed(2)}`, icon: isProfit ? TrendingUp : TrendingDown, cls: isProfit ? "text-profit" : "text-loss" },
              { label: "ROI", value: `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`, icon: BarChart3, cls: roi >= 0 ? "text-profit" : "text-loss" },
              { label: "Win Rate", value: stats?.totalTrades ? `${stats.winRate}%` : "--", icon: Target, cls: "" },
            ].map(({ label, value, icon: Icon, cls }) => (
              <div key={label} className="rounded-xl bg-secondary p-3">
                <div className="flex items-center gap-1 mb-1">
                  <Icon className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[9px] text-muted-foreground">{label}</span>
                </div>
                <p className={`text-sm font-medium tabular-nums ${cls}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* Performance chart */}
          <div className="rounded-xl bg-secondary p-4">
            <p className="text-xs text-muted-foreground mb-3 font-medium">Balance Over Time</p>
            {loadingChart ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : chartData.length <= 1 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-xs text-muted-foreground">No trade history yet</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(v) => `$${v}`}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "none", borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Balance"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="balance"
                    stroke={isProfit ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Trades summary */}
          {stats && stats.totalTrades > 0 && (
            <p className="text-xs text-muted-foreground">
              {stats.totalTrades} total trades · {stats.winningTrades}W / {stats.losingTrades}L
            </p>
          )}

          {/* Instructions */}
          {strategy.instructions && (
            <div className="rounded-xl bg-secondary p-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <BookOpen className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-medium">Agent Instructions</span>
              </div>
              <p className="text-xs text-foreground leading-relaxed line-clamp-4">{strategy.instructions}</p>
            </div>
          )}

          <div className="flex gap-3">
            <Button onClick={onEdit} variant="secondary" className="flex-1 rounded-full gap-2 text-sm">
              <Pencil className="h-3.5 w-3.5" /> Edit Strategy
            </Button>
            <Button variant="secondary" onClick={onClose} className="rounded-full px-5 text-sm">Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function StrategiesPanel() {
  const { strategies, strategyStats, loading, updateStrategy, addStrategy, deleteStrategy } = useStrategies();
  const [detailStrategy, setDetailStrategy] = useState<Strategy | null>(null);
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newStrategy, setNewStrategy] = useState({
    name: "", description: "", instructions: "", active: false,
    mode: "paper" as "paper" | "live", starting_balance: 1000,
  });

  const handleSaveEdit = () => {
    if (!editingStrategy) return;
    updateStrategy(editingStrategy.id, {
      name: editingStrategy.name,
      description: editingStrategy.description,
      instructions: editingStrategy.instructions,
      mode: editingStrategy.mode,
      starting_balance: editingStrategy.starting_balance,
    });
    setEditingStrategy(null);
  };

  const handleCreate = () => {
    if (!newStrategy.name.trim()) return;
    addStrategy(newStrategy);
    setNewStrategy({ name: "", description: "", instructions: "", active: false, mode: "paper", starting_balance: 1000 });
    setIsCreating(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-3 text-sm text-muted-foreground">Loading strategies...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 apple-reveal">
      <BudgetSummary strategies={strategies} />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: "-0.02em" }}>Strategies</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {strategies.length} strategies · {strategies.filter(s => s.active).length} active
          </p>
        </div>
        <Button onClick={() => setIsCreating(true)} className="rounded-full gap-2 text-sm px-5">
          <Plus className="h-4 w-4" /> New Strategy
        </Button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {strategies.map((strat) => {
          const stats = strategyStats[strat.id];
          const pnl = stats?.totalPnl ?? 0;
          const roi = stats?.roi ?? 0;
          const balance = stats?.balance ?? strat.starting_balance;

          return (
            <div
              key={strat.id}
              className={`rounded-2xl bg-card p-5 cursor-pointer transition-all duration-300 hover:apple-shadow-hover ${
                strat.active ? "apple-shadow ring-1 ring-primary/20" : "apple-shadow"
              }`}
              onClick={() => setDetailStrategy({ ...strat })}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="text-[10px] rounded-full font-mono px-2">{strat.id}</Badge>
                    <Badge variant="secondary" className={`text-[10px] rounded-full ${
                      strat.mode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"
                    }`}>{strat.mode}</Badge>
                  </div>
                  <h3 className="text-sm font-medium text-foreground">{strat.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{strat.description}</p>
                </div>
                <Switch
                  checked={strat.active}
                  onCheckedChange={(checked) => updateStrategy(strat.id, { active: checked })}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>

              {/* Performance Stats */}
              <div className="grid grid-cols-4 gap-2 mt-3">
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <DollarSign className="h-2.5 w-2.5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">Balance</span>
                  </div>
                  <p className="text-xs font-medium tabular-nums">${Math.round(balance).toLocaleString()}</p>
                </div>
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    {pnl >= 0 ? <TrendingUp className="h-2.5 w-2.5 text-profit" /> : <TrendingDown className="h-2.5 w-2.5 text-loss" />}
                    <span className="text-[9px] text-muted-foreground">P&L</span>
                  </div>
                  <p className={`text-xs font-medium tabular-nums ${pnl >= 0 ? "text-profit" : "text-loss"}`}>
                    {pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <BarChart3 className="h-2.5 w-2.5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">ROI</span>
                  </div>
                  <p className={`text-xs font-medium tabular-nums ${roi >= 0 ? "text-profit" : "text-loss"}`}>
                    {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <Target className="h-2.5 w-2.5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">Win</span>
                  </div>
                  <p className="text-xs font-medium tabular-nums">
                    {stats?.totalTrades ? `${stats.winRate}%` : "--"}
                  </p>
                </div>
              </div>

              {stats && stats.totalTrades > 0 && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  {stats.totalTrades} trades · {stats.winningTrades}W / {stats.losingTrades}L
                </p>
              )}

              {strat.instructions && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-3">
                  <BookOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate">{strat.instructions.slice(0, 60)}...</span>
                </div>
              )}

              <div className="flex gap-2 mt-4" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] rounded-full px-3 gap-1"
                  onClick={() => setEditingStrategy({ ...strat })}
                >
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] rounded-full px-3 gap-1 text-destructive"
                  onClick={() => deleteStrategy(strat.id)}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Strategy Detail Modal */}
      {detailStrategy && (
        <StrategyDetailModal
          strategy={detailStrategy}
          onClose={() => setDetailStrategy(null)}
          onEdit={() => {
            setEditingStrategy({ ...detailStrategy });
            setDetailStrategy(null);
          }}
        />
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editingStrategy} onOpenChange={(open) => !open && setEditingStrategy(null)}>
        <DialogContent className="rounded-2xl border-0 apple-shadow max-w-lg p-6">
          {editingStrategy && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg font-medium">
                  Edit Strategy
                  <Badge variant="secondary" className="ml-2 text-[10px] rounded-full font-mono">{editingStrategy.id}</Badge>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Name</Label>
                  <Input value={editingStrategy.name} onChange={(e) => setEditingStrategy({ ...editingStrategy, name: e.target.value })} className="rounded-xl border-0 bg-secondary" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Description</Label>
                  <Input value={editingStrategy.description} onChange={(e) => setEditingStrategy({ ...editingStrategy, description: e.target.value })} className="rounded-xl border-0 bg-secondary" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Agent Instructions</Label>
                  <p className="text-xs text-muted-foreground">These instructions are injected into the AI agent's context when this strategy is active.</p>
                  <Textarea
                    value={editingStrategy.instructions}
                    onChange={(e) => setEditingStrategy({ ...editingStrategy, instructions: e.target.value })}
                    className="rounded-xl border-0 bg-secondary text-sm min-h-[140px] resize-y"
                    placeholder="Describe how the agent should apply this strategy..."
                    style={{ resize: "vertical" }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm text-muted-foreground">Starting Balance ($)</Label>
                    <Input
                      type="number"
                      value={editingStrategy.starting_balance}
                      onChange={(e) => setEditingStrategy({ ...editingStrategy, starting_balance: Number(e.target.value) || 0 })}
                      className="rounded-xl border-0 bg-secondary"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm text-muted-foreground">Trading Mode</Label>
                    <div className="flex items-center gap-3 h-10">
                      <span className={`text-sm ${editingStrategy.mode === "paper" ? "text-primary" : "text-muted-foreground"}`}>Paper</span>
                      <Switch
                        checked={editingStrategy.mode === "live"}
                        onCheckedChange={(checked) => setEditingStrategy({ ...editingStrategy, mode: checked ? "live" : "paper" })}
                      />
                      <span className={`text-sm ${editingStrategy.mode === "live" ? "text-loss" : "text-muted-foreground"}`}>Live</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Active</Label>
                  <Switch checked={editingStrategy.active} onCheckedChange={(checked) => setEditingStrategy({ ...editingStrategy, active: checked })} />
                </div>
                <div className="flex gap-3 pt-2">
                  <Button onClick={handleSaveEdit} className="flex-1 rounded-full gap-2">
                    <Save className="h-4 w-4" /> Save
                  </Button>
                  <Button variant="secondary" onClick={() => setEditingStrategy(null)} className="rounded-full gap-2">
                    <X className="h-4 w-4" /> Cancel
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={isCreating} onOpenChange={setIsCreating}>
        <DialogContent className="rounded-2xl border-0 apple-shadow max-w-lg p-6">
          <DialogHeader>
            <DialogTitle className="text-lg font-medium">New Strategy</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Name</Label>
              <Input value={newStrategy.name} onChange={(e) => setNewStrategy({ ...newStrategy, name: e.target.value })} placeholder="e.g. Breakout Scanner" className="rounded-xl border-0 bg-secondary" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Description</Label>
              <Input value={newStrategy.description} onChange={(e) => setNewStrategy({ ...newStrategy, description: e.target.value })} placeholder="Short description" className="rounded-xl border-0 bg-secondary" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Agent Instructions</Label>
              <p className="text-xs text-muted-foreground">Tell the AI how to apply this strategy when trading.</p>
              <Textarea
                value={newStrategy.instructions}
                onChange={(e) => setNewStrategy({ ...newStrategy, instructions: e.target.value })}
                className="rounded-xl border-0 bg-secondary text-sm min-h-[120px] resize-y"
                placeholder="Describe how the AI agent should use this strategy..."
                style={{ resize: "vertical" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Starting Balance ($)</Label>
                <Input
                  type="number"
                  value={newStrategy.starting_balance}
                  onChange={(e) => setNewStrategy({ ...newStrategy, starting_balance: Number(e.target.value) || 0 })}
                  className="rounded-xl border-0 bg-secondary"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Mode</Label>
                <div className="flex items-center gap-3 h-10">
                  <span className={`text-sm ${newStrategy.mode === "paper" ? "text-primary" : "text-muted-foreground"}`}>Paper</span>
                  <Switch
                    checked={newStrategy.mode === "live"}
                    onCheckedChange={(checked) => setNewStrategy({ ...newStrategy, mode: checked ? "live" : "paper" })}
                  />
                  <span className={`text-sm ${newStrategy.mode === "live" ? "text-loss" : "text-muted-foreground"}`}>Live</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleCreate} disabled={!newStrategy.name.trim()} className="flex-1 rounded-full gap-2">
                <Plus className="h-4 w-4" /> Create
              </Button>
              <Button variant="secondary" onClick={() => setIsCreating(false)} className="rounded-full">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
