import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Canonical domain enforcement — redirect any non-production origin before React mounts.
// Handles both edge-cached responses and stale PWA service workers serving old origins.
const CANONICAL = "kalshitradeagent.com";
const STAGING = "kalshitradeagent.live";
const host = window.location.hostname;
if (
  host !== CANONICAL &&
  host !== `www.${CANONICAL}` &&
  host !== STAGING &&
  host !== "localhost" &&
  host !== "127.0.0.1" &&
  !host.endsWith(".vercel.app")
) {
  window.location.replace(`https://${CANONICAL}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

// Apply dark class from saved preference or system default
const saved = localStorage.getItem("theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

// When the service worker updates, show a banner instead of force-reloading.
// Force-reload races with Supabase's async localStorage init — getSession() can
// return null mid-mount and AdminRoute sets state to "denied".
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const banner = document.createElement("div");
    banner.id = "sw-update-banner";
    banner.style.cssText = [
      "position:fixed","bottom:1rem","left:50%","transform:translateX(-50%)",
      "background:#1c1917","color:#f5f5f4","border:1px solid #44403c",
      "border-radius:0.75rem","padding:0.625rem 1rem","font-size:12px",
      "display:flex","align-items:center","gap:0.75rem","z-index:9999",
      "box-shadow:0 4px 24px rgba(0,0,0,0.4)","white-space:nowrap",
    ].join(";");
    banner.innerHTML = `
      <span>New version available</span>
      <button onclick="window.location.reload()" style="background:#f97316;color:#fff;border:none;border-radius:0.375rem;padding:0.25rem 0.625rem;font-size:11px;cursor:pointer;font-weight:600">Reload</button>
    `;
    document.getElementById("sw-update-banner")?.remove();
    document.body.appendChild(banner);
  });

  // Poll for SW updates every 5 minutes so long-running sessions pick up new deploys.
  navigator.serviceWorker.ready.then((registration) => {
    setInterval(() => registration.update(), 5 * 60 * 1000);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
