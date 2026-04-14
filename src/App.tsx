import { useEffect, useState } from "react";
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

const queryClient = new QueryClient();

function AppRoutes() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Still loading — show nothing (avoids flash)
  if (session === undefined) return null;

  // Auth gate: every user must sign in before reaching the trading UI.
  // This is the multi-tenancy enforcement point — once past this gate,
  // every request includes a verified Supabase Auth JWT that edge functions
  // resolve to a user_id via the _shared/tenant helper.
  //
  // Set VITE_DISABLE_AUTH=true in .env.local for solo-developer mode that
  // bypasses this gate and operates as the legacy NULL-tenant.
  const authDisabled = import.meta.env.VITE_DISABLE_AUTH === "true";
  if (!authDisabled && !session) return <AuthPage />;

  return (
    <StrategiesProvider>
      <ChatProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ChatProvider>
    </StrategiesProvider>
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
