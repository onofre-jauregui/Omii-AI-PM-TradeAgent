import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

const SESSION_KEY = "liveModeBannerShown";
const VISIBLE_MS = 9000;   // how long the notice stays before it fades
const FADE_MS = 350;       // fade-out transition duration (keep in sync with duration-300 below)

/**
 * Transient live-mode notice. Shows once at the start of each browser session
 * (guarded by sessionStorage) and auto-dismisses after VISIBLE_MS with a fade.
 *
 * Replaces the old always-on sticky bar: it flags real-money mode on entry
 * without permanently occupying the header. Because the guard only writes when
 * the banner actually renders, it also appears the first time the user switches
 * into live mode within a session, then stays quiet on subsequent tab switches.
 */
export function LiveModeBanner() {
  const [show, setShow] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(SESSION_KEY) !== "1";
  });
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!show) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    const fade = setTimeout(() => setLeaving(true), VISIBLE_MS);
    const remove = setTimeout(() => setShow(false), VISIBLE_MS + FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(remove); };
  }, [show]);

  if (!show) return null;

  return (
    <div
      className={`sticky top-0 z-40 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-background transition-all duration-300 ${leaving ? "opacity-0 -translate-y-full" : "opacity-100 translate-y-0"}`}
      style={{ background: "hsl(var(--loss))" }}
      role="status"
      aria-label="Live trading mode active"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>LIVE MODE — Real money is active. The agent trades autonomously within your capital, loss, and position limits. Adjust them in Risk Controls.</span>
    </div>
  );
}
