// Dedicated Connected entrypoint, isolated from production and the comparison build.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "prototypes/connected",
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: "../../dist-connected-prototype", emptyOutDir: true },
});
