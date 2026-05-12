import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Sidebar } from "@/components/trading/Sidebar";
import { PortfolioChart } from "@/components/trading/PortfolioChart";
import { PortfolioOverview, PortfolioStats } from "@/components/trading/PortfolioOverview";
import { StrategyPerformance } from "@/components/trading/StrategyPerformance";
import { MarketsPanel } from "@/components/trading/MarketsPanel";
import { StrategiesPanel } from "@/components/trading/StrategiesPanel";
import { AgentPanel } from "@/components/trading/AgentPanel";
import { TradeLog } from "@/components/trading/TradeLog";
import { SettingsPanel } from "@/components/trading/SettingsPanel";
import { ProfilePanel } from "@/components/trading/ProfilePanel";
import { CompliancePanel } from "@/components/trading/CompliancePanel";

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
  const [agentSubTab, setAgentSubTab] = useState<"activity" | "history">("activity");
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? undefined);
    });
  }, []);

  function handleNavigate(tab: string) {
    if (tab === "performance") {
      navigate("/performance");
      return;
    }
    setActiveTab(tab as Tab);
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar activeTab={activeTab} onNavigate={handleNavigate} userEmail={userEmail} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header
          className="frosted-glass sticky top-0 z-40 h-12 flex items-center justify-between px-8 shrink-0"
          style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.08)" }}
        >
          <h1 className="text-sm font-medium text-foreground tracking-tight">
            {TAB_LABELS[activeTab]}
          </h1>

          {/* Paper / Live mode toggle — visible on dashboard and agent tabs */}
          {(activeTab === "dashboard" || activeTab === "agent") && (
            <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
              <button
                onClick={() => setMode("paper")}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  mode === "paper"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Paper
              </button>
              <button
                onClick={() => setMode("live")}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  mode === "live"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Live
              </button>
            </div>
          )}
        </header>

        <main className="flex-1 overflow-y-auto px-8 py-8 max-w-[900px] w-full mx-auto">

          {/* ── Dashboard ──────────────────────────────────────────── */}
          {activeTab === "dashboard" && (
            <div className="space-y-8 apple-reveal">
              <PortfolioStats mode={mode} />
              <PortfolioChart mode={mode} />
              <StrategyPerformance mode={mode} />
              <PortfolioOverview mode={mode} />
            </div>
          )}

          {/* ── Agent ──────────────────────────────────────────────── */}
          {activeTab === "agent" && (
            <div className="space-y-6 apple-reveal">
              {/* Sub-tabs */}
              <div className="flex gap-0 border-b border-border">
                {(["activity", "history"] as const).map((sub) => (
                  <button
                    key={sub}
                    onClick={() => setAgentSubTab(sub)}
                    className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                      agentSubTab === sub
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {sub === "activity" ? "Activity" : "Trade History"}
                  </button>
                ))}
              </div>
              {agentSubTab === "activity" && <AgentPanel />}
              {agentSubTab === "history" && <TradeLog filterMode={mode} />}
            </div>
          )}

          {/* ── Markets ────────────────────────────────────────────── */}
          {activeTab === "markets" && (
            <div className="space-y-8 apple-reveal">
              <MarketsPanel mode="paper" />
              <StrategiesPanel />
            </div>
          )}

          {/* ── Settings ───────────────────────────────────────────── */}
          {activeTab === "settings" && (
            <div className="space-y-8 apple-reveal">
              <SettingsPanel />
              <CompliancePanel />
              <ProfilePanel />
            </div>
          )}

        </main>
      </div>
    </div>
  );
};

export default Index;
