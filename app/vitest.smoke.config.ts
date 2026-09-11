import { defineConfig } from "vitest/config";

// Runs the built Worker (dist/server/wrangler.json) in workerd through Wrangler.
// Run `npm run build` first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
