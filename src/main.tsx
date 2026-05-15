import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Apply dark class from saved preference or system default
const saved = localStorage.getItem("theme");
if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root")!).render(<App />);
