import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Sidebar } from "@/components/trading/Sidebar";
import { BottomNav } from "@/components/trading/BottomNav";
import { DashboardHero } from "@/components/trading/DashboardHero";
import { PortfolioOverview } from "@/components/trading/PortfolioOverview";
import { StrategyPerformance } from "@/components/trading/StrategyPerformance";
import { MarketsPanel } from "@/components/trading/MarketsPanel";
import { StrategiesPanel } from "@/components/trading/StrategiesPanel";
import { AgentPanel } from "@/components/trading/AgentPanel";
import { TradeLog } from "@/components/trading/TradeLog";
import { RiskControlsPanel } from "@/components/trading/RiskControlsPanel";
import { SettingsPanel } from "@/components/trading/SettingsPanel";
import { ProfilePanel } from "@/components/trading/ProfilePanel";
import { AgentMemoryCard } from "@/components/trading/AgentMemoryCard";
import { StrategyStories } from "@/components/trading/StrategyStories";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Bot, Lock } from "lucide-react";
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
  const [agentSubTab, setAgentSubTab] = useState<"chat" | "strategies" | "risk" | "history" | "memory">("chat");
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const [userId, setUserId] = useState<string | undefined>();
  const [subscriptionTier, setSubscriptionTier] = useState<"free" | "starter" | "pro" | "prop">("free");
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [marketToOpen, setMarketToOpen] = useState<string | null>(null);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  useEffect(() => {
    // onAuthStateChange fires immediately with the current session AND again after
    // OAuth redirects complete — so panels never render in an unauthenticated limbo.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setUserEmail(session?.user?.email ?? undefined);
      setUserId(session?.user?.id ?? undefined);
      if (session?.user?.id) {
        const [profileRes, subRes] = await Promise.all([
          supabase.from("profiles").select("trading_mode").eq("id", session.user.id).single(),
          supabase.from("subscriptions").select("tier, status").eq("user_id", session.user.id).maybeSingle(),
        ]);
        if (profileRes.data?.trading_mode === "live" || profileRes.data?.trading_mode === "paper") {
          setMode(profileRes.data.trading_mode);
        }
        if (subRes.data?.tier && (subRes.data.status === "active" || subRes.data.status === "trialing")) {
          setSubscriptionTier(subRes.data.tier as typeof subscriptionTier);
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleModeChange(next: Mode) {
    if (next === "live" && subscriptionTier === "free") {
      setShowUpgradeModal(true);
      return;
    }
    setMode(next);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      supabase.from("profiles").update({ trading_mode: next }).eq("id", user.id);
    }
  }

  const handleOpenMarket = (ticker: string) => {
    setMarketToOpen(ticker);
    setActiveTab("markets");
  };

  function handleNavigate(tab: string) {
    if (tab === "performance") {
      navigate("/performance");
      return;
    }
    setActiveTab(tab as Tab);
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Upgrade modal — shown when free-tier user tries to enable live trading */}
      {showUpgradeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowUpgradeModal(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-2xl p-8 text-center"
            style={{ background: "var(--background)", boxShadow: "0 24px 48px rgba(0,0,0,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="mx-auto mb-4 flex items-center justify-center rounded-full"
              style={{ width: 48, height: 48, background: "var(--secondary)" }}
            >
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-2">Live trading is locked</h2>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              Your current plan only supports paper trading. Upgrade to Starter ($99/mo) to enable live trading on Kalshi.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { setShowUpgradeModal(false); navigate("/billing"); }}
                className="w-full rounded-full py-3 text-sm font-medium text-white"
                style={{ background: "#0071e3" }}
              >
                View plans
              </button>
              <button
                onClick={() => setShowUpgradeModal(false)}
                className="w-full rounded-full py-3 text-sm font-medium text-muted-foreground"
                style={{ background: "var(--secondary)" }}
              >
                Stay on paper
              </button>
            </div>
          </div>
        </div>
      )}

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

              {/* Right: profile avatar — toggles settings/dashboard */}
              <button
                onClick={() => handleNavigate(activeTab === "settings" ? "dashboard" : "settings")}
                className="shrink-0 active:scale-95 transition-transform"
                title={activeTab === "settings" ? "Back to dashboard" : "Profile & settings"}
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
                <div className="flex flex-col items-end gap-0.5">
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
                  {mode === "paper" && (
                    <span className="text-[10px] text-muted-foreground/60 pr-1">Live strategies still running</span>
                  )}
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
          {/* All tabs stay mounted — hidden with CSS so state/data survive tab switches.
              Conditional rendering (unmount/remount) caused dashoard to hang in loading
              state on every return because all useEffect data fetches re-fired from scratch. */}
          <div className={cn("space-y-6", activeTab !== "dashboard" && "hidden")}>
            <DashboardHero mode={mode} onNavigate={handleNavigate} userId={userId} />
            <StrategyStories mode={mode} onNavigate={handleNavigate} />
            <StrategyPerformance mode={mode} />
            <PortfolioOverview mode={mode} />
            <TradeLog filterMode={mode} />
          </div>

          {/* ── Agent ──────────────────────────────────────────────── */}
          <div className={cn("space-y-5", activeTab !== "agent" && "hidden")}>
            {/* Sub-tabs — Claude/OpenAI style */}
            <div className="flex gap-1 overflow-x-auto scrollbar-none">
              {([
                { id: "chat",       label: "Chat"       },
                { id: "strategies", label: "Strategies" },
                { id: "risk",       label: "Risk"       },
                { id: "memory",     label: "Memory"     },
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
            {agentSubTab === "chat"       && <AgentPanel mode={mode} onOpenMarket={handleOpenMarket} />}
            {agentSubTab === "strategies" && <StrategiesPanel mode={mode} subscriptionTier={subscriptionTier} />}
            {agentSubTab === "risk"       && <RiskControlsPanel />}
            {agentSubTab === "memory"     && <AgentMemoryCard full />}
          </div>

          {/* ── Markets ────────────────────────────────────────────── */}
          <div className={cn(activeTab !== "markets" && "hidden")}>
            <MarketsPanel mode={mode} openMarketTicker={marketToOpen} onMarketOpened={() => setMarketToOpen(null)} />
          </div>

          {/* ── Settings ───────────────────────────────────────────── */}
          <div className={cn("space-y-6", activeTab !== "settings" && "hidden")}>
            <ProfilePanel mode={mode} userEmail={userEmail} userId={userId} />
            <SettingsPanel userId={userId} />
          </div>

        </main>
      </div>

      {isMobile && (
        <BottomNav activeTab={activeTab} onNavigate={handleNavigate} mode={mode} />
      )}
    </div>
  );
};

export default Index;
