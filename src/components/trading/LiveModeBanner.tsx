import { AlertTriangle } from "lucide-react";

/**
 * Persistent top banner shown when trading mode is "live".
 * Purpose: make it unmistakable that real money is at stake.
 * Absent in paper mode.
 */
export function LiveModeBanner() {
  return (
    <div
      className="sticky top-0 z-40 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-background"
      style={{ background: "hsl(var(--loss))" }}
      role="banner"
      aria-label="Live trading mode active"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>LIVE MODE — Real money is active. Every trade needs your approval (in-app or Telegram) before it executes.</span>
    </div>
  );
}
