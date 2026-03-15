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

const Index = () => {
  const [activeTab, setActiveTab] = useState("dashboard");

  return (
    <div className="min-h-screen bg-background terminal-grid">
      <AppHeader onNavigate={setActiveTab} />
      <main className="container mx-auto px-4 py-6 max-w-[1400px]">
        <div className="mb-6">
          <PortfolioChart />
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-card border border-border p-1 h-auto flex-wrap">
            <TabsTrigger value="dashboard" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              DASHBOARD
            </TabsTrigger>
            <TabsTrigger value="markets" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              MARKETS
            </TabsTrigger>
            <TabsTrigger value="strategies" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              STRATEGIES
            </TabsTrigger>
            <TabsTrigger value="agent" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              AI AGENT
            </TabsTrigger>
            <TabsTrigger value="log" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              TRADE LOG
            </TabsTrigger>
            <TabsTrigger value="settings" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              SETTINGS
            </TabsTrigger>
            <TabsTrigger value="profile" className="font-mono text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              PROFILE
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard">
            <PortfolioOverview />
          </TabsContent>
          <TabsContent value="markets">
            <MarketsPanel />
          </TabsContent>
          <TabsContent value="strategies">
            <StrategiesPanel />
          </TabsContent>
          <TabsContent value="agent">
            <AgentPanel />
          </TabsContent>
          <TabsContent value="log">
            <TradeLog />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsPanel />
          </TabsContent>
          <TabsContent value="profile">
            <ProfilePanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
