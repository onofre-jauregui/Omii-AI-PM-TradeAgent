import { Bot, User, Zap, CheckCircle, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  mode?: "paper" | "live";
  userEmail?: string;
}

export function AccountStatusCard({ mode = "paper", userEmail }: Props) {
  const [kalshiConnected, setKalshiConnected] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("api_keys")
      .select("provider")
      .then(({ data }) => {
        if (!data) return;
        const providers = new Set(data.map(r => r.provider));
        setKalshiConnected(providers.has("kalshi_live"));
        const preferred = ["openrouter", "anthropic", "openai", "google"].find(p => providers.has(p));
        setActiveProvider(preferred ?? null);
      });
  }, []);

  const providerLabel: Record<string, string> = {
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google AI",
  };

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Agent &amp; Account</h3>
        <span className="flex items-center gap-1 text-[10px] text-profit bg-profit/10 px-2 py-0.5 rounded-full ml-auto">
          <span className="h-1.5 w-1.5 rounded-full bg-profit animate-pulse-gentle" />
          Active
        </span>
      </div>
      <div className="divide-y divide-border">
        {/* Account email */}
        <div className="flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground">Account</span>
          </div>
          <span className="text-sm text-foreground font-medium truncate max-w-[200px]">
            {userEmail ?? "—"}
          </span>
        </div>

        {/* Trading mode */}
        <div className="flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground">Trading Mode</span>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
            mode === "live"
              ? "bg-loss/10 text-loss"
              : "bg-primary/10 text-primary"
          }`}>
            {mode === "live" ? "Live" : "Paper"}
          </span>
        </div>

        {/* AI model */}
        <div className="flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground">AI Provider</span>
          </div>
          <div className="flex items-center gap-1.5">
            {activeProvider ? (
              <CheckCircle className="h-3 w-3 text-profit" />
            ) : (
              <Circle className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="text-sm text-foreground">
              {activeProvider ? providerLabel[activeProvider] : "Not configured"}
            </span>
          </div>
        </div>

        {/* Kalshi */}
        <div className="flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground">Kalshi</span>
          </div>
          <div className="flex items-center gap-1.5">
            {kalshiConnected ? (
              <>
                <CheckCircle className="h-3 w-3 text-profit" />
                <span className="text-sm text-foreground">Connected</span>
              </>
            ) : (
              <>
                <Circle className="h-3 w-3 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Not connected</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
