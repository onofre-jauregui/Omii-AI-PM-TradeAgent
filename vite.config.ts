import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    VitePWA({
      // New service worker activates automatically — no "reload to update" prompt needed.
      registerType: "autoUpdate",

      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        // Pre-cache all built static assets. API calls (Supabase, Kalshi) are
        // intentionally excluded from caching so trading data is always live.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [],
      },

      manifest: {
        name: "TradeAgent",
        short_name: "TradeAgent",
        description: "AI-powered Kalshi prediction market trading",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },

      // Disable SW in dev — avoids stale cache during hot reload
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
