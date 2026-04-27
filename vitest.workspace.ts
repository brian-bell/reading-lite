import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { defineProject } from "vitest/config";

export default [
  defineWorkersProject({
    test: {
      name: "workers",
      include: [
        "test/integration/**/*.test.ts",
        "test/unit/schemas/**/*.test.ts",
        "test/unit/extractor/**/*.test.ts",
        "test/unit/embeddings/**/*.test.ts",
        "test/unit/anthropic/**/*.test.ts",
        "test/unit/stores/**/*.test.ts",
      ],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.test.toml" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
          },
        },
      },
    },
  }),
  defineProject({
    test: {
      name: "node",
      include: ["test/unit/migrate/**/*.test.ts"],
      environment: "node",
    },
  }),
];
