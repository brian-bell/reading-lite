import path from "node:path";
import { defineWorkersProject, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { defineProject } from "vitest/config";

const AUTH_ROOT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

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
        "test/unit/modules/**/*.test.ts",
        "test/unit/process-reading/**/*.test.ts",
        "test/unit/attempt-activation/**/*.test.ts",
        "test/unit/reading-visibility/**/*.test.ts",
      ],
      setupFiles: ["./test/apply-control-plane.ts"],
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
              AUTH_ROOT_SECRET,
              FOUNDER_EMAIL: "founder@test.example",
              TEST_MIGRATIONS: migrations,
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
        "test/unit/staleness/**/*.test.ts",
        "test/unit/lib/**/*.test.ts",
        "test/unit/import-bookmarks/**/*.test.ts",
        "test/unit/import-markdown/**/*.test.ts",
        "test/unit/deploy/**/*.test.ts",
        "test/unit/corpus/**/*.test.ts",
        "test/unit/reddit-import/**/*.test.ts",
        "test/unit/youtube-import/**/*.test.ts",
        "test/unit/check-corpus/**/*.test.ts",
        "test/unit/process-reading-list/**/*.test.ts",
        "test/unit/extract-agent/**/*.test.ts",
        "test/unit/control-plane/**/*.test.ts",
        "test/unit/scripts/**/*.test.ts",
      ],
      environment: "node",
    },
  }),
];
