import { useState } from "react";
import {
  LayoutDashboard, TrendingUp, Cpu, MessageSquare, ClipboardList,
  ShieldCheck, Settings, User, ChevronLeft, ChevronRight, Activity, Bot, LogOut,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

interface SidebarProps {
  activeTab: string;
  onNavigate: (tab: string) => void;
  userEmail?: string;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "markets", label: "Markets", icon: TrendingUp },
  { id: "strategies", label: "Strategies", icon: Cpu },
  { id: "agent", label: "Agent", icon: MessageSquare },
  { id: "log", label: "Trade Log", icon: ClipboardList },
  { id: "compliance", label: "Compliance", icon: ShieldCheck },
];

const BOTTOM_ITEMS = [
  { id: "settings", label: "Settings", icon: Settings },
  { id: "profile", label: "Profile", icon: User },
];

export function Sidebar({ activeTab, onNavigate, userEmail }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex flex-col h-screen sticky top-0 bg-card border-r border-border transition-all duration-300 ease-in-out shrink-0",
        collapsed ? "w-[56px]" : "w-[220px]"
      )}
    >
      {/* Logo + collapse button */}
      <div className={cn(
        "flex items-center h-12 border-b border-border px-3 shrink-0",
        collapsed ? "justify-center" : "justify-between"
      )}>
        {!collapsed && (
          <div className="flex items-center gap-2 overflow-hidden">
            <Bot className="h-4 w-4 text-foreground shrink-0" />
            <span className="text-sm font-medium tracking-tight text-foreground truncate">
              Trade Agent
            </span>
          </div>
        )}
        {collapsed && <Bot className="h-4 w-4 text-foreground" />}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "rounded-lg p-1 text-muted-foreground hover:text-foreground hover:bg-secondary transition-all duration-200",
            collapsed && "mt-0"
          )}
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={cn(
                "w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-all duration-200",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                collapsed && "justify-center px-0"
              )}
              title={collapsed ? label : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Bottom: live status + profile/settings */}
      <div className="shrink-0 border-t border-border py-3 px-2 space-y-0.5">
        {/* Live indicator */}
        <div className={cn(
          "flex items-center gap-2 px-2.5 py-1.5 text-xs text-profit",
          collapsed && "justify-center"
        )}>
          <Activity className="h-3 w-3 shrink-0" />
          {!collapsed && <span>Live</span>}
        </div>

        {BOTTOM_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={cn(
                "w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-all duration-200",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                collapsed && "justify-center px-0"
              )}
              title={collapsed ? label : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </button>
          );
        })}

        {/* Profile avatar + sign out */}
        <div className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-2 mt-1",
          collapsed && "justify-center px-0"
        )}>
          <Avatar className="h-6 w-6 shrink-0">
            <AvatarFallback className="bg-secondary text-foreground text-[9px] font-medium">
              {userEmail ? userEmail[0].toUpperCase() : "T"}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <>
              <div className="overflow-hidden flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">
                  {userEmail ?? "Trader"}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">Paper mode</p>
              </div>
              <button
                onClick={() => supabase.auth.signOut()}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
