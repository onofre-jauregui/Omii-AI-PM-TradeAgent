import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sidebar } from "@/components/trading/Sidebar";
import { PortfolioChart } from "@/components/trading/PortfolioChart";
import { PortfolioOverview, PortfolioStats } from "@/components/trading/PortfolioOverview";
import { StrategyPerformance } from "@/components/trading/StrategyPerformance";
import { MarketsPanel } from "@/components/trading/MarketsPanel";
import { StrategiesPanel } from "@/components/trading/StrategiesPanel";
import { AgentPanel } from "@/components/trading/AgentPanel";
import { DemoPanel } from "@/components/trading/DemoPanel";
import { TradeLog } from "@/components/trading/TradeLog";
import { SettingsPanel } from "@/components/trading/SettingsPanel";
import { ProfilePanel } from "@/components/trading/ProfilePanel";
import { CompliancePanel } from "@/components/trading/CompliancePanel";

const TAB_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  markets: "Markets",
  strategies: "Strategies",
  demo: "Demo — Paper Trading",
  agent: "Live Agent",
  log: "Trade Log",
  compliance: "Compliance",
  settings: "Settings",
  profile: "Profile",
};

const Index = () => {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [userEmail, setUserEmail] = useState<string | undefined>();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? undefined);
    });
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar activeTab={activeTab} onNavigate={setActiveTab} userEmail={userEmail} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header — active page name centered */}
        <header
          className="frosted-glass sticky top-0 z-40 h-12 flex items-center justify-center shrink-0"
          style={{ boxShadow: "0 1px 0 rgba(0,0,0,0.08)" }}
        >
          <h1 className="text-sm font-medium text-foreground tracking-tight">
            {TAB_LABELS[activeTab] ?? activeTab}
          </h1>
        </header>

        <main className="flex-1 overflow-y-auto px-8 py-8 max-w-[900px] w-full mx-auto">
          {activeTab === "dashboard" && (
            <div className="space-y-8 apple-reveal">
              <PortfolioStats mode="live" />
              <PortfolioChart />
              <StrategyPerformance />
              <PortfolioOverview mode="live" />
            </div>
          )}
          {activeTab === "markets" && <MarketsPanel />}
          {activeTab === "strategies" && <StrategiesPanel />}
          {activeTab === "demo" && <DemoPanel />}
          {activeTab === "agent" && <AgentPanel />}
          {activeTab === "log" && <TradeLog filterMode="live" />}
          {activeTab === "compliance" && <CompliancePanel />}
          {activeTab === "settings" && <SettingsPanel />}
          {activeTab === "profile" && <ProfilePanel />}
        </main>
      </div>
    </div>
  );
};

export default Index;
