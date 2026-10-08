import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit and component tests. They import modules directly, without the Start or
// Cloudflare plugins; the built Worker is exercised by vitest.smoke.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
