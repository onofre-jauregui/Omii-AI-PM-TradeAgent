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
        // Only precache hashed JS/CSS/icon assets — NOT index.html.
        // index.html references hashed filenames that change on every deploy;
        // if the SW serves a stale index.html the browser requests old JS bundles
        // that no longer exist → blank screen. Navigation always hits the network.
        globPatterns: ["**/*.{js,css,ico,png,svg,woff2}"],
        // Navigation requests (HTML) → network first, fall back to cached index.html
        // if offline. This guarantees the app shell is always fresh after a deploy.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "navigation",
              networkTimeoutSeconds: 5,
            },
          },
        ],
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
