import { useEffect, useState, useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StrategiesProvider } from "@/lib/strategiesContext";
import { ChatProvider } from "@/lib/chatContext";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import LandingPage from "./pages/LandingPage.tsx";
import PerformancePage from "./pages/PerformancePage.tsx";
import SignupPage from "./pages/SignupPage.tsx";
import OnboardingPage from "./pages/OnboardingPage.tsx";
import WaitlistPage from "./pages/admin/WaitlistPage.tsx";
import CostReport from "./pages/admin/CostReport.tsx";
import BillingPage from "./pages/BillingPage.tsx";
import TermsPage from "./pages/TermsPage.tsx";
import PrivacyPage from "./pages/PrivacyPage.tsx";
import ObservabilityPage from "./pages/ObservabilityPage.tsx";

const queryClient = new QueryClient();

/** Gate that checks profiles.is_admin — DB is the source of truth, works for any admin. */
function AdminRoute({ element }: { element: React.ReactElement }) {
  const [state, setState] = useState<"loading" | "ok" | "denied" | "login">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const checkAdmin = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return setState("login");
    const { data } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", session.user.id)
      .maybeSingle();
    setState((data as any)?.is_admin ? "ok" : "denied");
  }, []);

  useEffect(() => { checkAdmin(); }, [checkAdmin]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setLoginError(error.message); setLoggingIn(false); return; }
    checkAdmin();
  }

  if (state === "loading") return null;

  if (state === "login") {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "#0f0d0b" }}>
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-4 p-8 rounded-2xl" style={{ background: "#1a1714" }}>
          <p className="text-xs text-muted-foreground uppercase tracking-widest mb-6">Admin access</p>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-lg px-4 py-3 text-sm bg-black/40 border border-white/10 text-foreground placeholder:text-muted-foreground outline-none focus:border-white/30"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded-lg px-4 py-3 text-sm bg-black/40 border border-white/10 text-foreground placeholder:text-muted-foreground outline-none focus:border-white/30"
          />
          {loginError && <p className="text-xs text-red-400">{loginError}</p>}
          <button
            type="submit"
            disabled={loggingIn}
            className="w-full rounded-lg py-3 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "#0071e3" }}
          >
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "#0f0d0b" }}>
        <p className="text-sm text-muted-foreground">Access denied — admin only.</p>
      </div>
    );
  }

  return element;
}

/** Protected portion of the app — requires a valid session. */
function ProtectedApp({ session }: { session: Session | null | undefined }) {
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);

  // Still loading — show nothing (avoids flash)
  if (session === undefined) return null;

  // Auth gate: every user must sign in before reaching the trading UI.
  // Set VITE_DISABLE_AUTH=true in .env.local for solo-developer / NULL-tenant mode.
  const authDisabled = import.meta.env.VITE_DISABLE_AUTH === "true";
  if (!authDisabled && !session) {
    // Root path shows the marketing landing page; everything else redirects to /login.
    if (window.location.pathname === "/") return <LandingPage />;
    window.location.replace("/login");
    return null;
  }

  // Check onboarding completion for authenticated users (skip in auth-disabled dev mode)
  if (session && !authDisabled && onboardingCompleted === null) {
    supabase
      .from("profiles")
      .select("onboarding_completed")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setOnboardingCompleted(data?.onboarding_completed ?? false);
      });
    return null; // wait for profile check
  }

  // New user — hasn't completed onboarding yet
  if (session && !authDisabled && onboardingCompleted === false) {
    // Use window.location to avoid needing useNavigate outside Router context
    if (window.location.pathname !== "/onboarding") {
      window.location.replace("/onboarding");
    }
    return null;
  }

  return (
    <StrategiesProvider>
      <ChatProvider>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ChatProvider>
    </StrategiesProvider>
  );
}

function AppRoutes() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public — no auth required */}
        <Route path="/login" element={<AuthPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/performance" element={<PerformancePage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        {/* Admin-only — requires is_admin = true in profiles */}
        <Route path="/observability" element={<AdminRoute element={<ObservabilityPage />} />} />
        <Route path="/admin/waitlist" element={<AdminRoute element={<WaitlistPage />} />} />
        <Route path="/admin/costs" element={<AdminRoute element={<CostReport />} />} />
        {/* Auth-protected — onboarding + billing */}
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/billing" element={<BillingPage />} />
        {/* Everything else goes through the auth gate */}
        <Route path="*" element={<ProtectedApp session={session} />} />
      </Routes>
    </BrowserRouter>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AppRoutes />
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
