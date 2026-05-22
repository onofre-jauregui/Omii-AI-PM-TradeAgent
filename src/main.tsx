import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Apply dark class from saved preference or system default
const saved = localStorage.getItem("theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

// When the service worker updates (new deploy), show a banner instead of force-reloading.
// Force-reloading races with Supabase's async localStorage init — getSession() returns
// null mid-read, AdminRoute sees no session, and the user gets "Access denied".
// Plain DOM so it works before React mounts and survives re-renders.
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
}

createRoot(document.getElementById("root")!).render(<App />);
