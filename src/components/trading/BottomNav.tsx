import { LayoutDashboard, Bot, BarChart2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface BottomNavProps {
  activeTab: string;
  onNavigate: (tab: string) => void;
  mode?: "paper" | "live";
  tier?: string;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Home",     icon: LayoutDashboard },
  { id: "agent",     label: "Agent",    icon: Bot },
  { id: "markets",   label: "Markets",  icon: BarChart2 },
  { id: "settings",  label: "Settings", icon: Settings },
];

export function BottomNav({ activeTab, onNavigate, mode, tier }: BottomNavProps) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 frosted-glass border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-stretch h-14">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={cn(
                "flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px]",
                "transition-all duration-150 active:scale-95",
                active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <div className="relative flex flex-col items-center">
                <Icon className={cn("h-5 w-5 transition-transform duration-150", active && "scale-110")} />

                {/* Live mode danger dot on Agent tab */}
                {id === "agent" && mode === "live" && (
                  <span className="absolute -top-0.5 -right-1 h-2 w-2 rounded-full bg-red-500" />
                )}

                {/* Active pill indicator */}
                {active && (
                  <span className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 h-0.5 w-4 rounded-full bg-primary" />
                )}
              </div>

              <span className={cn(
                "text-[10px] font-medium mt-1.5 transition-colors leading-none",
                active ? "text-foreground" : "text-muted-foreground"
              )}>
                {label}
              </span>

              {/* Tier badge on Settings tab */}
              {id === "settings" && tier && tier !== "pro" && tier !== "prop" && (
                <span className="text-[8px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full -mt-0.5">
                  {tier === "starter" ? "STARTER" : "FREE"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
