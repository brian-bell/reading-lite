// Isolated design study (prototypes/next-directions): no Start plugin, no
// Cloudflare plugin, no API proxy, no deployment binding. `npm run
// prototype:dev` serves it on :5175 so it can run beside `npm run dev`.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "prototypes/next-directions",
  plugins: [react()],
  server: { port: 5175 },
  build: { outDir: "../../dist-prototypes", emptyOutDir: true },
});
