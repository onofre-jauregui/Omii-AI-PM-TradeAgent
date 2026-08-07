import { useState } from "react";
import {
  LayoutDashboard, BarChart2, Settings, ChevronLeft, ChevronRight,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeTab: string;
  onNavigate: (tab: string) => void;
  userEmail?: string; // retained for API compatibility — no longer displayed in sidebar
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "agent",     label: "Agent",     icon: Bot },
  { id: "markets",   label: "Markets",   icon: BarChart2 },
];

const BOTTOM_ITEMS = [
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({ activeTab, onNavigate }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col h-screen sticky top-0 bg-card border-r border-border transition-all duration-300 ease-in-out shrink-0",
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
              // Active state was carried by background colour alone, which no
              // screen reader and no test can read. aria-current is the
              // accessible "you are here" and is what the tab persistence E2E
              // asserts against.
              aria-current={active ? "page" : undefined}
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

        {/* Agent active status — non-interactive, bottom of nav list */}
        <div className={cn(
          "flex items-center gap-2 px-2.5 py-1.5 text-xs text-profit mt-1",
          collapsed && "justify-center"
        )}>
          <span className="h-1.5 w-1.5 rounded-full bg-profit animate-pulse-gentle shrink-0" />
          {!collapsed && <span>Agent Active</span>}
        </div>
      </nav>

      {/* Bottom: settings */}
      <div className="shrink-0 border-t border-border py-3 px-2 space-y-0.5">
        {BOTTOM_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              // Active state was carried by background colour alone, which no
              // screen reader and no test can read. aria-current is the
              // accessible "you are here" and is what the tab persistence E2E
              // asserts against.
              aria-current={active ? "page" : undefined}
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
      </div>
    </aside>
  );
}
