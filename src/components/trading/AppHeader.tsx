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
import { supabase } from "@/integrations/supabase/client";

interface AppHeaderProps {
  onNavigate?: (tab: string) => void;
}

export function AppHeader({ onNavigate }: AppHeaderProps) {
  return (
    <header className="frosted-glass sticky top-0 z-50 transition-shadow duration-300" style={{ boxShadow: '0 1px 0 rgba(0,0,0,0.1)' }}>
      <div className="mx-auto max-w-[980px] px-6 flex items-center justify-between h-12">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-foreground" />
            <span className="text-sm font-medium tracking-tight text-foreground">
              Omii TradeAgent
            </span>
            <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-full">
              Kalshi
            </span>
          </div>
        </div>
        <nav className="hidden md:flex items-center gap-8">
          <button onClick={() => onNavigate?.("dashboard")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Dashboard
          </button>
          <button onClick={() => onNavigate?.("markets")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Markets
          </button>
          <button onClick={() => onNavigate?.("strategies")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Strategies
          </button>
          <button onClick={() => onNavigate?.("agent")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Agent
          </button>
          <button onClick={() => onNavigate?.("log")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Trade Log
          </button>
          <button onClick={() => onNavigate?.("compliance")} className="text-xs text-muted-foreground hover:text-foreground transition-colors duration-300">
            Compliance
          </button>
        </nav>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1.5 text-profit">
              <Activity className="h-3 w-3" />
              Live
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Zap className="h-3 w-3 text-warning" />
              Idle
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar className="h-7 w-7 cursor-pointer transition-opacity duration-300 hover:opacity-80">
                  <AvatarFallback className="bg-secondary text-foreground text-[10px] font-medium">
                    AT
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 rounded-xl apple-shadow">
              <div className="px-3 py-2.5">
                <p className="text-sm font-medium text-foreground">Anon Trader</p>
                <p className="text-xs text-muted-foreground">trader@example.com</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-sm cursor-pointer gap-2" onClick={() => onNavigate?.("profile")}>
                <User className="h-4 w-4" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem className="text-sm cursor-pointer gap-2" onClick={() => onNavigate?.("settings")}>
                <Settings className="h-4 w-4" /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-sm cursor-pointer gap-2 text-destructive" onClick={() => supabase.auth.signOut()}>
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
