import { Activity, Bot, Zap } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { User, Settings, LogOut } from "lucide-react";

interface AppHeaderProps {
  onNavigate?: (tab: string) => void;
}

export function AppHeader({ onNavigate }: AppHeaderProps) {
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background">
                <Avatar className="h-8 w-8 cursor-pointer border border-border hover:border-primary/50 transition-colors">
                  <AvatarFallback className="bg-primary/10 text-primary font-mono text-xs">
                    AT
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 bg-card border-border">
              <div className="px-3 py-2">
                <p className="text-sm font-mono font-medium text-foreground">Anon Trader</p>
                <p className="text-xs font-mono text-muted-foreground">trader@example.com</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="font-mono text-xs cursor-pointer gap-2"
                onClick={() => onNavigate?.("profile")}
              >
                <User className="h-3.5 w-3.5" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                className="font-mono text-xs cursor-pointer gap-2"
                onClick={() => onNavigate?.("settings")}
              >
                <Settings className="h-3.5 w-3.5" /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="font-mono text-xs cursor-pointer gap-2 text-loss">
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
