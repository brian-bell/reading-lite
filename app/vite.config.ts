import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react()],
  server: {
    // Browser calls reach the local backend (`npm run dev` at the repo root) as
    // same-origin /api, as web/ does. The app itself never proxies in deployed
    // environments; see ADR 0003.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
