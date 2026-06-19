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
        "test/unit/email/**/*.test.ts",
        "test/unit/http-retry/**/*.test.ts",
        "test/unit/queue/**/*.test.ts",
        "test/unit/stores/**/*.test.ts",
        "test/unit/process-reading/**/*.test.ts",
      ],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.test.toml" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            // Pin the secret-shaped bindings to known test values so that any
            // .dev.vars present on the developer's machine cannot leak real
            // credentials into the test process or override the test token.
            bindings: {
              READER_API_TOKEN: "test-token",
              ANTHROPIC_API_KEY: "test-anthropic-key",
              OPENAI_API_KEY: "test-openai-key",
              RESEND_API_KEY: "test-resend-key",
            },
          },
        },
      },
    },
  }),
  defineProject({
    test: {
      name: "node",
      include: [
        "test/unit/lib/**/*.test.ts",
        "test/unit/import-bookmarks/**/*.test.ts",
        "test/unit/import-markdown/**/*.test.ts",
        "test/unit/corpus/**/*.test.ts",
        "test/unit/check-corpus/**/*.test.ts",
        "test/unit/process-reading-list/**/*.test.ts",
      ],
      environment: "node",
    },
  }),
];
