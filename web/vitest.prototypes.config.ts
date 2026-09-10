// Keep the design simulation's browser state out of the production SPA test run.
import { defineConfig, mergeConfig } from "vitest/config";
import webConfig from "./vite.config";

export default mergeConfig(webConfig, defineConfig({
  test: { include: ["prototypes/**/*.prototype.tsx"] },
}));
