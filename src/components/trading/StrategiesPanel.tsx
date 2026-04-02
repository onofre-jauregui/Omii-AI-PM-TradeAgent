import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, BookOpen, Save, X, TrendingUp, TrendingDown, BarChart3, Target, DollarSign, Loader2 } from "lucide-react";
import { useState } from "react";
import { useStrategies, type Strategy } from "@/lib/strategiesContext";

export function StrategiesPanel() {
  const { strategies, strategyStats, loading, updateStrategy, addStrategy, deleteStrategy } = useStrategies();
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Strategies</h2>
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
                strat.active ? 'apple-shadow ring-1 ring-primary/20' : 'apple-shadow'
              }`}
              onClick={() => setEditingStrategy({ ...strat })}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="text-[10px] rounded-full font-mono px-2">
                      {strat.id}
                    </Badge>
                    <Badge variant="secondary" className={`text-[10px] rounded-full ${
                      strat.mode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"
                    }`}>
                      {strat.mode}
                    </Badge>
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
                  <p className={`text-xs font-medium tabular-nums ${pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <BarChart3 className="h-2.5 w-2.5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">ROI</span>
                  </div>
                  <p className={`text-xs font-medium tabular-nums ${roi >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-2">
                  <div className="flex items-center gap-1 mb-0.5">
                    <Target className="h-2.5 w-2.5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">Win</span>
                  </div>
                  <p className="text-xs font-medium tabular-nums">
                    {stats?.totalTrades ? `${stats.winRate}%` : '--'}
                  </p>
                </div>
              </div>

              {/* Trades count */}
              {stats && stats.totalTrades > 0 && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  {stats.totalTrades} trades · {stats.winningTrades}W / {stats.losingTrades}L
                </p>
              )}

              {/* Instructions preview */}
              {strat.instructions && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-3">
                  <BookOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate">{strat.instructions.slice(0, 60)}...</span>
                </div>
              )}

              {/* Actions */}
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
                  <Textarea value={editingStrategy.instructions} onChange={(e) => setEditingStrategy({ ...editingStrategy, instructions: e.target.value })} className="rounded-xl border-0 bg-secondary text-sm min-h-[180px] resize-none" placeholder="Describe how the agent should apply this strategy..." />
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
              <Textarea value={newStrategy.instructions} onChange={(e) => setNewStrategy({ ...newStrategy, instructions: e.target.value })} className="rounded-xl border-0 bg-secondary text-sm min-h-[160px] resize-none" placeholder="Describe how the AI agent should use this strategy..." />
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
