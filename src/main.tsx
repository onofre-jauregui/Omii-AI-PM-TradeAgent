import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Apply dark class from saved preference or system default
const saved = localStorage.getItem("theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

// When the service worker updates (new deploy), reload immediately so the active
// page never runs stale JS. skipWaiting + clientsClaim in vite.config installs the
// new SW instantly; this listener fires the reload so the page picks it up.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(<App />);
