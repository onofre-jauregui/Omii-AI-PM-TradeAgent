import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, BookOpen, Save, X } from "lucide-react";
import { useState } from "react";
import { useStrategies, type Strategy } from "@/lib/strategiesContext";

export function StrategiesPanel() {
  const { strategies, updateStrategy, addStrategy, deleteStrategy } = useStrategies();
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newStrategy, setNewStrategy] = useState({ name: "", description: "", instructions: "", active: false });
  const [riskLevel, setRiskLevel] = useState([50]);
  const [maxPosition, setMaxPosition] = useState([500]);
  const [timeframe, setTimeframe] = useState("1h");

  const handleSaveEdit = () => {
    if (!editingStrategy) return;
    updateStrategy(editingStrategy.id, {
      name: editingStrategy.name,
      description: editingStrategy.description,
      instructions: editingStrategy.instructions,
    });
    setEditingStrategy(null);
  };

  const handleCreate = () => {
    if (!newStrategy.name.trim()) return;
    addStrategy(newStrategy);
    setNewStrategy({ name: "", description: "", instructions: "", active: false });
    setIsCreating(false);
  };

  return (
    <div className="space-y-8 apple-reveal">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Strategies</h2>
          <p className="text-sm text-muted-foreground mt-1">Configure trading strategies for the AI agent.</p>
        </div>
        <Button onClick={() => setIsCreating(true)} className="rounded-full gap-2 text-sm px-5">
          <Plus className="h-4 w-4" /> New Strategy
        </Button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {strategies.map((strat) => (
          <div
            key={strat.id}
            className={`rounded-2xl bg-card p-5 cursor-pointer transition-all duration-300 hover:apple-shadow-hover ${strat.active ? 'apple-shadow ring-1 ring-primary/20' : 'apple-shadow'}`}
            onClick={() => setEditingStrategy({ ...strat })}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 min-w-0 pr-3">
                <h3 className="text-sm font-medium text-foreground">{strat.name}</h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{strat.description}</p>
              </div>
              <Switch
                checked={strat.active}
                onCheckedChange={(checked) => updateStrategy(strat.id, { active: checked })}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            {strat.instructions && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-3">
                <BookOpen className="h-3 w-3 shrink-0" />
                <span className="truncate">{strat.instructions.slice(0, 70)}...</span>
              </div>
            )}
            <div className="flex gap-2 mt-4">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[11px] rounded-full px-3 gap-1"
                onClick={(e) => { e.stopPropagation(); setEditingStrategy({ ...strat }); }}
              >
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              {strat.id.startsWith("custom-") && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] rounded-full px-3 gap-1 text-destructive"
                  onClick={(e) => { e.stopPropagation(); deleteStrategy(strat.id); }}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Global Parameters */}
      <div className="rounded-2xl bg-card p-6 apple-shadow space-y-6">
        <h3 className="text-sm font-medium text-muted-foreground">Global Parameters</h3>
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Risk Tolerance</Label>
              <span className="text-sm text-foreground">{riskLevel[0]}%</span>
            </div>
            <Slider value={riskLevel} onValueChange={setRiskLevel} max={100} step={5} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Max Position Size</Label>
              <span className="text-sm text-foreground">${maxPosition[0]}</span>
            </div>
            <Slider value={maxPosition} onValueChange={setMaxPosition} max={5000} step={100} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Timeframe</Label>
            <Select value={timeframe} onValueChange={setTimeframe}>
              <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5m">5 Minutes</SelectItem>
                <SelectItem value="15m">15 Minutes</SelectItem>
                <SelectItem value="1h">1 Hour</SelectItem>
                <SelectItem value="4h">4 Hours</SelectItem>
                <SelectItem value="1d">1 Day</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingStrategy} onOpenChange={(open) => !open && setEditingStrategy(null)}>
        <DialogContent className="rounded-2xl border-0 apple-shadow max-w-lg p-6">
          {editingStrategy && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg font-medium">Edit Strategy</DialogTitle>
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
