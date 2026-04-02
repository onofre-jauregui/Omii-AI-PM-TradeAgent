import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppHeader } from "@/components/trading/AppHeader";
import { PortfolioChart } from "@/components/trading/PortfolioChart";
import { PortfolioOverview } from "@/components/trading/PortfolioOverview";
import { MarketsPanel } from "@/components/trading/MarketsPanel";
import { StrategiesPanel } from "@/components/trading/StrategiesPanel";
import { AgentPanel } from "@/components/trading/AgentPanel";
import { TradeLog } from "@/components/trading/TradeLog";
import { SettingsPanel } from "@/components/trading/SettingsPanel";
import { ProfilePanel } from "@/components/trading/ProfilePanel";
import { CompliancePanel } from "@/components/trading/CompliancePanel";

const Index = () => {
  const [activeTab, setActiveTab] = useState("dashboard");

  return (
    <div className="min-h-screen bg-background">
      <AppHeader onNavigate={setActiveTab} />
      <main className="mx-auto max-w-[980px] px-6 py-12">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
          <TabsList className="md:hidden bg-secondary rounded-full p-1 h-auto flex-wrap">
            {["dashboard", "markets", "strategies", "agent", "log", "compliance", "settings", "profile"].map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className="text-xs rounded-full px-4 py-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:apple-shadow transition-all duration-300"
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="dashboard">
            <div className="mb-12 apple-reveal">
              <PortfolioChart />
            </div>
            <PortfolioOverview />
          </TabsContent>
          <TabsContent value="markets"><MarketsPanel /></TabsContent>
          <TabsContent value="strategies"><StrategiesPanel /></TabsContent>
          <TabsContent value="agent"><AgentPanel /></TabsContent>
          <TabsContent value="log"><TradeLog /></TabsContent>
          <TabsContent value="compliance"><CompliancePanel /></TabsContent>
          <TabsContent value="settings"><SettingsPanel /></TabsContent>
          <TabsContent value="profile"><ProfilePanel /></TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
