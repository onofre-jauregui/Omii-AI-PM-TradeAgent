import { Activity, Bot, Zap } from "lucide-react";

export function AppHeader() {
  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 max-w-[1400px] flex items-center justify-between h-14">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            <span className="font-mono font-bold text-lg text-foreground tracking-tight">
              POLYBOT
            </span>
          </div>
          <span className="text-xs font-mono text-muted-foreground border border-border px-2 py-0.5 rounded-sm">
            v0.1.0
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="flex items-center gap-1 text-profit">
              <Activity className="h-3 w-3 animate-pulse-glow" />
              LIVE
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <Zap className="h-3 w-3 text-warning" />
            <span>AGENT: IDLE</span>
          </div>
        </div>
      </div>
    </header>
  );
}
