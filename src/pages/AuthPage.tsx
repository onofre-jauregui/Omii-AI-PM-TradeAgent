import { useState } from "react";
import { Bot, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

export function AuthPage() {
  const returnTo = new URLSearchParams(window.location.search).get("return") || "/";
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + returnTo },
    });
    if (error) { setError(error.message); setLoading(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      } else {
        window.location.replace(returnTo);
        return;
      }
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
      } else {
        setMessage("Check your email for a confirmation link, then sign in.");
        setMode("login");
      }
    }
    setLoading(false);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: "#0f0d0b", color: "#eee8df" }}
    >
      <div className="w-full max-w-sm">
        {/* Back link */}
        <div className="mb-6">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: "#8a7f74" }}
          >
            ← Back to home
          </a>
        </div>

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500">
              <Bot className="h-4 w-4 text-white" />
            </div>
            <span className="text-lg font-medium tracking-tight" style={{ color: "#eee8df" }}>Omii TradeAgent</span>
          </div>
          <p className="text-xs" style={{ color: "#8a7f74" }}>AI-powered Kalshi trading</p>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-6 space-y-5"
          style={{ backgroundColor: "#1c1814", border: "1px solid #2e2720" }}
        >
          <div>
            <h2 className="text-base font-medium" style={{ color: "#eee8df" }}>
              {mode === "login" ? "Sign in" : "Create account"}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "#8a7f74" }}>
              {mode === "login" ? "Access your trading dashboard" : "Start trading with AI"}
            </p>
          </div>

          {/* Google OAuth */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2.5 rounded-full text-sm font-medium py-2.5 transition-colors disabled:opacity-50"
            style={{ border: "1px solid #2e2720", backgroundColor: "#241f1a", color: "#eee8df" }}
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ backgroundColor: "#2e2720" }} />
            <span className="text-xs" style={{ color: "#8a7f74" }}>or</span>
            <div className="flex-1 h-px" style={{ backgroundColor: "#2e2720" }} />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm" style={{ color: "#8a7f74" }}>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="rounded-xl border-0 text-sm"
                style={{ backgroundColor: "#241f1a", color: "#eee8df" }}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm" style={{ color: "#8a7f74" }}>Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="rounded-xl border-0 text-sm pr-10"
                  style={{ backgroundColor: "#241f1a", color: "#eee8df" }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: "#8a7f74" }}
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-xs rounded-lg px-3 py-2" style={{ color: "#f87171", backgroundColor: "rgba(248,113,113,0.1)" }}>{error}</p>
            )}
            {message && (
              <p className="text-xs rounded-lg px-3 py-2" style={{ color: "#4ade80", backgroundColor: "rgba(74,222,128,0.1)" }}>{message}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full text-sm font-semibold py-2.5 transition-colors disabled:opacity-50 flex items-center justify-center"
              style={{ backgroundColor: "#f97316", color: "#fff" }}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="text-center">
            <button
              type="button"
              onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); setMessage(null); }}
              className="text-xs transition-colors"
              style={{ color: "#8a7f74" }}
            >
              {mode === "login" ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
