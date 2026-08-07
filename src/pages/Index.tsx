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
import { LiveModeBanner } from "@/components/trading/LiveModeBanner";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Bot, Lock, LayoutDashboard, Settings, LogOut } from "lucide-react";
import { PAID_TIERS, BILLING_LIVE, tierPriceLabel } from "@/lib/pricing";
import { readUiState, writeUiState, clearUiState, DEFAULT_UI_STATE } from "@/lib/uiState";
import type { AgentSubTab } from "@/lib/uiState";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Tab = "dashboard" | "agent" | "markets" | "settings";
type Mode = "paper" | "live";

// Cheapest paid plan — what the live-trading upgrade prompt points a free user at.
const ENTRY_PAID_TIER = PAID_TIERS[0];

const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Dashboard",
  agent: "Agent",
  markets: "Markets",
  settings: "Settings",
};

const Index = () => {
  // Restored synchronously from localStorage so a reload or PWA relaunch paints
  // the tab the user left on — no dashboard flash before the real tab appears.
  // The restored state is discarded below if it belongs to a different account.
  const restoredUiState = readUiState();
  const [activeTab, setActiveTab] = useState<Tab>(restoredUiState.activeTab);
  const [mode, setMode] = useState<Mode>("paper");
  const [agentSubTab, setAgentSubTab] = useState<AgentSubTab>(restoredUiState.agentSubTab);
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const [userId, setUserId] = useState<string | undefined>();
  const [subscriptionTier, setSubscriptionTier] = useState<"free" | "starter" | "pro" | "prop">("free");
  const [isAdmin, setIsAdmin] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [marketToOpen, setMarketToOpen] = useState<string | null>(null);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  useEffect(() => {
    // onAuthStateChange fires immediately with the current session AND again after
    // OAuth redirects complete — so panels never render in an unauthenticated limbo.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setUserEmail(session?.user?.email ?? undefined);
      setUserId(session?.user?.id ?? undefined);

      // Two "initiation" boundaries reset the remembered tab: signing out, and a
      // session belonging to a different account than the stored state. Both mean
      // the next view should be the default paper Dashboard, not someone's leftover tab.
      const storedOwner = readUiState().userId;
      const isSignedOut = event === "SIGNED_OUT" || !session?.user?.id;
      if (isSignedOut || (storedOwner && storedOwner !== session!.user.id)) {
        clearUiState();
        setActiveTab(DEFAULT_UI_STATE.activeTab);
        setAgentSubTab(DEFAULT_UI_STATE.agentSubTab);
      }

      if (session?.user?.id) {
        const [profileRes, subRes] = await Promise.all([
          supabase.from("profiles").select("trading_mode, is_admin").eq("id", session.user.id).single(),
          supabase.from("subscriptions").select("tier, status").eq("user_id", session.user.id).maybeSingle(),
        ]);
        if (profileRes.data?.trading_mode === "live" || profileRes.data?.trading_mode === "paper") {
          setMode(profileRes.data.trading_mode);
        }
        setIsAdmin(profileRes.data?.is_admin ?? false);
        if (subRes.data?.tier && (subRes.data.status === "active" || subRes.data.status === "trialing")) {
          setSubscriptionTier(subRes.data.tier as typeof subscriptionTier);
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Persist the current tab for this account on every change. Only runs once the
  // session is known, so the stored row is always stamped with its real owner.
  useEffect(() => {
    if (!userId) return;
    writeUiState({ userId, activeTab, agentSubTab });
  }, [userId, activeTab, agentSubTab]);

  async function handleModeChange(next: Mode) {
    if (next === "live" && subscriptionTier === "free" && !isAdmin) {
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
              {BILLING_LIVE
                ? `Your current plan only supports paper trading. Upgrade to ${ENTRY_PAID_TIER.name} (${tierPriceLabel(ENTRY_PAID_TIER)}/mo) to enable live trading on Kalshi.`
                : `Your current plan only supports paper trading. Live accounts are in closed access while we validate paper performance — join the waitlist and we'll email you when a spot opens. ${ENTRY_PAID_TIER.name} starts at ${tierPriceLabel(ENTRY_PAID_TIER)}/mo.`}
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
        {/* Live mode safety banner — must be unmissable */}
        {mode === "live" && <LiveModeBanner />}

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

              {/* Right: profile avatar — dropdown menu; the same tap opens and closes it */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="shrink-0 rounded-full active:scale-95 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Account menu"
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-secondary text-foreground text-[11px] font-medium">
                        {userEmail ? userEmail[0].toUpperCase() : "T"}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 rounded-xl apple-shadow">
                  {userEmail && (
                    <>
                      <div className="px-3 py-2.5">
                        <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
                      </div>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem className="text-sm cursor-pointer gap-2" onClick={() => handleNavigate("dashboard")}>
                    <LayoutDashboard className="h-4 w-4" /> Dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-sm cursor-pointer gap-2" onClick={() => handleNavigate("settings")}>
                    <Settings className="h-4 w-4" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-sm cursor-pointer gap-2 text-destructive" onClick={() => supabase.auth.signOut()}>
                    <LogOut className="h-4 w-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
            {agentSubTab === "strategies" && <StrategiesPanel mode={mode} />}
            {agentSubTab === "risk"       && <RiskControlsPanel mode={mode} />}
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
