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

  useEffect(() => {
    // getSession() may race with localStorage rehydration — also listen for auth
    // state changes so the check re-runs once the session is fully available.
    checkAdmin();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => checkAdmin());
    return () => subscription.unsubscribe();
  }, [checkAdmin]);

  async function handleGoogleLogin() {
    setLoggingIn(true);
    setLoginError("");
    // Encode the current path in redirectTo so Supabase lands back here after OAuth
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) { setLoginError(error.message); setLoggingIn(false); }
  }

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
        <div className="w-full max-w-sm space-y-4 p-8 rounded-2xl" style={{ background: "#1a1714" }}>
          <p className="text-xs text-muted-foreground uppercase tracking-widest mb-6">Admin access</p>

          {/* Google — primary path */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loggingIn}
            className="w-full rounded-lg py-3 text-sm font-medium flex items-center justify-center gap-2 border border-white/10 text-foreground disabled:opacity-50 hover:bg-white/5 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            {loggingIn ? "Redirecting…" : "Continue with Google"}
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* Email/password fallback */}
          <form onSubmit={handleLogin} className="space-y-3">
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
