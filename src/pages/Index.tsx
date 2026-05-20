import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Sidebar } from "@/components/trading/Sidebar";
import { BottomNav } from "@/components/trading/BottomNav";
import { DashboardHero } from "@/components/trading/DashboardHero";
import { PortfolioChart } from "@/components/trading/PortfolioChart";
import { PortfolioOverview, PortfolioStats } from "@/components/trading/PortfolioOverview";
import { StrategyPerformance } from "@/components/trading/StrategyPerformance";
import { MarketsPanel } from "@/components/trading/MarketsPanel";
import { StrategiesPanel } from "@/components/trading/StrategiesPanel";
import { AgentPanel } from "@/components/trading/AgentPanel";
import { TradeLog } from "@/components/trading/TradeLog";
import { RiskControlsPanel } from "@/components/trading/RiskControlsPanel";
import { SettingsPanel } from "@/components/trading/SettingsPanel";
import { ProfilePanel } from "@/components/trading/ProfilePanel";
import { AccountStatusCard } from "@/components/trading/AccountStatusCard";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type Tab = "dashboard" | "agent" | "markets" | "settings";
type Mode = "paper" | "live";

const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Dashboard",
  agent: "Agent",
  markets: "Markets",
  settings: "Settings",
};

const Index = () => {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [mode, setMode] = useState<Mode>("paper");
  const [agentSubTab, setAgentSubTab] = useState<"chat" | "strategies" | "risk" | "history">("chat");
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? undefined);
      if (session?.user?.id) {
        const { data } = await supabase
          .from("profiles")
          .select("trading_mode")
          .eq("id", session.user.id)
          .single();
        if (data?.trading_mode === "live" || data?.trading_mode === "paper") {
          setMode(data.trading_mode);
        }
      }
    });
  }, []);

  async function handleModeChange(next: Mode) {
    setMode(next);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      supabase.from("profiles").update({ trading_mode: next }).eq("id", user.id);
    }
  }

  function handleNavigate(tab: string) {
    if (tab === "performance") {
      navigate("/performance");
      return;
    }
    setActiveTab(tab as Tab);
  }

  return (
    <div className="flex min-h-screen bg-background">
      {!isMobile && (
        <Sidebar activeTab={activeTab} onNavigate={handleNavigate} userEmail={userEmail} />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header
          className={cn(
            "frosted-glass sticky top-0 z-40 shrink-0",
            isMobile ? "h-14 px-4" : "h-12 px-8"
          )}
          style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.08)" }}
        >
          {isMobile ? (
            /* Mobile: 3-column [Logo | toggle | avatar] */
            <div className="flex items-center justify-between h-full gap-2">
              {/* Left: brand */}
              <div className="flex items-center gap-2 shrink-0">
                <Bot className="h-4 w-4 text-foreground" />
                <span className="text-sm font-semibold tracking-tight text-foreground">TradeAgent</span>
              </div>

              {/* Center: Paper/Live toggle (dashboard + agent only) */}
              <div className="flex-1 flex justify-center">
                {(activeTab === "dashboard" || activeTab === "agent") && (
                  <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
                    <button
                      onClick={() => handleModeChange("paper")}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                        mode === "paper" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                      }`}
                    >
                      Paper
                    </button>
                    <button
                      onClick={() => handleModeChange("live")}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                        mode === "live" ? "bg-red-500 text-white shadow-sm" : "text-muted-foreground"
                      }`}
                    >
                      Live
                    </button>
                  </div>
                )}
              </div>

              {/* Right: profile avatar → taps to settings */}
              <button
                onClick={() => handleNavigate("settings")}
                className="shrink-0 active:scale-95 transition-transform"
                title="Settings"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-secondary text-foreground text-[11px] font-medium">
                    {userEmail ? userEmail[0].toUpperCase() : "T"}
                  </AvatarFallback>
                </Avatar>
              </button>
            </div>
          ) : (
            /* Desktop: tab label left + toggle right */
            <div className="flex items-center justify-between h-full">
              <h1 className="text-sm font-medium text-foreground tracking-tight">
                {TAB_LABELS[activeTab]}
              </h1>
              {(activeTab === "dashboard" || activeTab === "agent") && (
                <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
                  <button
                    onClick={() => handleModeChange("paper")}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                      mode === "paper" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Paper
                  </button>
                  <button
                    onClick={() => handleModeChange("live")}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                      mode === "live" ? "bg-red-500 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Live
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        <main className={cn(
          "flex-1 overflow-y-auto py-6 max-w-[900px] w-full mx-auto",
          isMobile
            ? "px-4 pb-[calc(80px+env(safe-area-inset-bottom,0px))]"
            : "px-8 pb-8"
        )}>

          {/* ── Dashboard ──────────────────────────────────────────── */}
          {activeTab === "dashboard" && (
            <div className="space-y-6 apple-reveal">
              <DashboardHero mode={mode} onNavigate={handleNavigate} />
              {!isMobile && <PortfolioStats mode={mode} />}
              <PortfolioChart mode={mode} />
              <StrategyPerformance mode={mode} />
              <PortfolioOverview mode={mode} />
            </div>
          )}

          {/* ── Agent ──────────────────────────────────────────────── */}
          {activeTab === "agent" && (
            <div className="space-y-5 apple-reveal">
              {/* Sub-tabs — Claude/OpenAI style */}
              <div className="flex gap-1 overflow-x-auto scrollbar-none">
                {([
                  { id: "chat",       label: "Chat"       },
                  { id: "strategies", label: "Strategies" },
                  { id: "risk",       label: "Risk"       },
                  { id: "history",    label: "History"    },
                ] as const).map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setAgentSubTab(id)}
                    className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-all duration-150 ${
                      agentSubTab === id
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {agentSubTab === "chat"       && <AgentPanel mode={mode} />}
              {agentSubTab === "strategies" && <StrategiesPanel />}
              {agentSubTab === "risk"       && <RiskControlsPanel />}
              {agentSubTab === "history"    && <TradeLog filterMode={mode} />}
            </div>
          )}

          {/* ── Markets ────────────────────────────────────────────── */}
          {activeTab === "markets" && (
            <div className="apple-reveal">
              <MarketsPanel mode={mode} />
            </div>
          )}

          {/* ── Settings ───────────────────────────────────────────── */}
          {activeTab === "settings" && (
            <div className="space-y-6 apple-reveal">
              <ProfilePanel />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div className="lg:col-span-2">
                  <SettingsPanel />
                </div>
                <div className="space-y-6">
                  <AccountStatusCard mode={mode} userEmail={userEmail} />
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {isMobile && (
        <BottomNav activeTab={activeTab} onNavigate={handleNavigate} mode={mode} />
      )}
    </div>
  );
};

export default Index;
