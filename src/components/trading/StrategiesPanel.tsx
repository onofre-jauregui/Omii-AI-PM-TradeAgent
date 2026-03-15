import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Settings2, Plus, Pencil, Trash2, BookOpen, Save, X } from "lucide-react";
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
    <div className="space-y-6 animate-slide-up">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm text-muted-foreground flex items-center gap-2">
          <Settings2 className="h-4 w-4" /> TRADING STRATEGIES
        </h2>
        <Button
          size="sm"
          onClick={() => setIsCreating(true)}
          className="font-mono text-xs gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> NEW STRATEGY
        </Button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {strategies.map((strat) => (
          <Card
            key={strat.id}
            className={`bg-card border-border transition-all cursor-pointer hover:border-primary/50 ${strat.active ? 'border-primary/50 glow-primary' : ''}`}
            onClick={() => setEditingStrategy({ ...strat })}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-3">
                  <h3 className="text-sm font-mono font-semibold">{strat.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{strat.description}</p>
                </div>
                <Switch
                  checked={strat.active}
                  onCheckedChange={(checked) => {
                    updateStrategy(strat.id, { active: checked });
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              {strat.instructions && (
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground mt-2">
                  <BookOpen className="h-3 w-3" />
                  <span className="truncate">{strat.instructions.slice(0, 60)}...</span>
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] font-mono gap-1"
                  onClick={(e) => { e.stopPropagation(); setEditingStrategy({ ...strat }); }}
                >
                  <Pencil className="h-3 w-3" /> EDIT
                </Button>
                {!strat.id.startsWith("momentum") && !strat.id.startsWith("mean") && !strat.id.startsWith("arb") && !strat.id.startsWith("sent") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] font-mono gap-1 text-loss border-loss/30 hover:bg-loss/10"
                    onClick={(e) => { e.stopPropagation(); deleteStrategy(strat.id); }}
                  >
                    <Trash2 className="h-3 w-3" /> DELETE
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Global Parameters */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="font-mono text-sm text-muted-foreground">GLOBAL PARAMETERS</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-mono text-muted-foreground">RISK TOLERANCE</Label>
              <span className="text-xs font-mono text-foreground">{riskLevel[0]}%</span>
            </div>
            <Slider value={riskLevel} onValueChange={setRiskLevel} max={100} step={5} className="w-full" />
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-mono text-muted-foreground">MAX POSITION SIZE</Label>
              <span className="text-xs font-mono text-foreground">${maxPosition[0]}</span>
            </div>
            <Slider value={maxPosition} onValueChange={setMaxPosition} max={5000} step={100} className="w-full" />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-mono text-muted-foreground">TIMEFRAME</Label>
            <Select value={timeframe} onValueChange={setTimeframe}>
              <SelectTrigger className="bg-secondary border-border font-mono text-sm">
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
        </CardContent>
      </Card>

      {/* Edit Strategy Dialog */}
      <Dialog open={!!editingStrategy} onOpenChange={(open) => !open && setEditingStrategy(null)}>
        <DialogContent className="bg-card border-border max-w-lg">
          {editingStrategy && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono text-sm">EDIT STRATEGY</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-mono text-muted-foreground">NAME</Label>
                  <Input
                    value={editingStrategy.name}
                    onChange={(e) => setEditingStrategy({ ...editingStrategy, name: e.target.value })}
                    className="bg-secondary border-border font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-mono text-muted-foreground">DESCRIPTION</Label>
                  <Input
                    value={editingStrategy.description}
                    onChange={(e) => setEditingStrategy({ ...editingStrategy, description: e.target.value })}
                    className="bg-secondary border-border font-mono text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-mono text-muted-foreground">
                    AGENT INSTRUCTIONS
                  </Label>
                  <p className="text-[10px] text-muted-foreground">
                    These instructions are passed to the AI agent when this strategy is active. Tell the model how to apply this strategy, what signals to look for, and how to manage risk.
                  </p>
                  <Textarea
                    value={editingStrategy.instructions}
                    onChange={(e) => setEditingStrategy({ ...editingStrategy, instructions: e.target.value })}
                    className="bg-secondary border-border font-mono text-xs min-h-[200px] resize-none"
                    placeholder="Describe how the AI agent should use this strategy..."
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-mono">Active</Label>
                  <Switch
                    checked={editingStrategy.active}
                    onCheckedChange={(checked) => setEditingStrategy({ ...editingStrategy, active: checked })}
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleSaveEdit} className="flex-1 font-mono text-xs gap-2">
                    <Save className="h-4 w-4" /> SAVE CHANGES
                  </Button>
                  <Button variant="outline" onClick={() => setEditingStrategy(null)} className="font-mono text-xs gap-2">
                    <X className="h-4 w-4" /> CANCEL
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Strategy Dialog */}
      <Dialog open={isCreating} onOpenChange={setIsCreating}>
        <DialogContent className="bg-card border-border max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">CREATE NEW STRATEGY</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-mono text-muted-foreground">NAME</Label>
              <Input
                value={newStrategy.name}
                onChange={(e) => setNewStrategy({ ...newStrategy, name: e.target.value })}
                placeholder="e.g. Breakout Scanner"
                className="bg-secondary border-border font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-mono text-muted-foreground">DESCRIPTION</Label>
              <Input
                value={newStrategy.description}
                onChange={(e) => setNewStrategy({ ...newStrategy, description: e.target.value })}
                placeholder="Short description of the strategy"
                className="bg-secondary border-border font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-mono text-muted-foreground">AGENT INSTRUCTIONS</Label>
              <p className="text-[10px] text-muted-foreground">
                Write detailed instructions for the AI agent. Describe signals, entry/exit rules, risk management, and any specific conditions.
              </p>
              <Textarea
                value={newStrategy.instructions}
                onChange={(e) => setNewStrategy({ ...newStrategy, instructions: e.target.value })}
                className="bg-secondary border-border font-mono text-xs min-h-[180px] resize-none"
                placeholder="Describe how the AI agent should use this strategy..."
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={!newStrategy.name.trim()} className="flex-1 font-mono text-xs gap-2">
                <Plus className="h-4 w-4" /> CREATE STRATEGY
              </Button>
              <Button variant="outline" onClick={() => setIsCreating(false)} className="font-mono text-xs">
                CANCEL
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
