// Isolated design study: no production entrypoint, API proxy, or deployment binding.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "prototypes/interface-directions",
  plugins: [react()],
  build: { outDir: "../../dist-prototypes", emptyOutDir: true },
});
