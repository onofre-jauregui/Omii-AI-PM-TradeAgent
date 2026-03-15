import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Settings2, Play, Pause, RotateCcw } from "lucide-react";
import { useState } from "react";

const STRATEGIES = [
  { id: "momentum", name: "Momentum", desc: "Buy when price trends upward with volume confirmation" },
  { id: "mean-reversion", name: "Mean Reversion", desc: "Trade against extreme price moves expecting reversion" },
  { id: "arbitrage", name: "Cross-Market Arb", desc: "Exploit price differences across correlated markets" },
  { id: "sentiment", name: "AI Sentiment", desc: "Use AI to analyze news & social sentiment for signals" },
];

export function StrategiesPanel() {
  const [activeStrategies, setActiveStrategies] = useState<Record<string, boolean>>({
    momentum: true,
    "mean-reversion": false,
    arbitrage: true,
    sentiment: false,
  });
  const [riskLevel, setRiskLevel] = useState([50]);
  const [maxPosition, setMaxPosition] = useState([500]);
  const [timeframe, setTimeframe] = useState("1h");

  const toggleStrategy = (id: string) => {
    setActiveStrategies(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="grid md:grid-cols-2 gap-4">
        {STRATEGIES.map((strat) => (
          <Card key={strat.id} className={`bg-card border-border transition-all ${activeStrategies[strat.id] ? 'border-primary/50 glow-primary' : ''}`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-mono font-semibold">{strat.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{strat.desc}</p>
                </div>
                <Switch
                  checked={activeStrategies[strat.id]}
                  onCheckedChange={() => toggleStrategy(strat.id)}
                />
              </div>
              {activeStrategies[strat.id] && (
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono gap-1">
                    <Settings2 className="h-3 w-3" /> CONFIG
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono gap-1 text-profit border-profit/30 hover:bg-profit/10">
                    <Play className="h-3 w-3" /> RUN
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

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
    </div>
  );
}
