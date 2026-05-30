import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Canonical domain enforcement — redirect any non-production origin before React mounts.
// Handles both edge-cached responses and stale PWA service workers serving old origins.
const CANONICAL = "kalshitradeagent.com";
const host = window.location.hostname;
if (host !== CANONICAL && host !== `www.${CANONICAL}` && host !== "localhost" && host !== "127.0.0.1") {
  window.location.replace(`https://${CANONICAL}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

// Apply dark class from saved preference or system default
const saved = localStorage.getItem("theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

// When the service worker updates (new deploy), reload immediately.
// AdminRoute now uses onAuthStateChange so it re-checks session after reload —
// the previous race condition with Supabase localStorage init is gone.
if ("serviceWorker" in navigator) {
  // Auto-reload when the SW takes control after an update
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });

  // Poll for SW updates every 5 minutes so long-running sessions always pick up
  // new deployments without waiting for the next full page navigation.
  navigator.serviceWorker.ready.then((registration) => {
    setInterval(() => registration.update(), 5 * 60 * 1000);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
