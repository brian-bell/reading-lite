import path from "node:path";
import { defineWorkersProject, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults, defineProject } from "vitest/config";
import { testDatabaseUrl } from "./test/helpers/test-database";

const AUTH_ROOT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// The workers pool reaches PostgreSQL through the HYPERDRIVE binding. Its
// connection string is set explicitly on both workers projects, to the database
// globalSetup migrates and truncates, so it overrides wrangler.test.toml and
// whatever Hyperdrive variable a developer exports for `npm run dev`. Setting
// the variable here instead does not work: this file's `process.env` is not the
// host's (see hostEnv).
const hyperdrives = { HYPERDRIVE: testDatabaseUrl() };

// Unit tests that need the Workers runtime: they import cloudflare:test or
// cloudflare:workers (directly or through src/index.ts), or they assert on
// workerd semantics that Node lacks (safe-fetch: workerd's Request accepts a
// userinfo URL, Node's throws). Every other unit test runs in the Node pool,
// which skips the per-file D1 migration and founder bootstrap in
// test/apply-control-plane.ts that dominates the workers pool's wall time.
// Integration tests always run on workerd.
const WORKERS_RUNTIME_UNIT_TESTS = [
  "test/unit/extractor/safe-fetch.test.ts",
  "test/unit/intake/activation.test.ts",
  "test/unit/intake/intake.test.ts",
  "test/unit/modules/processing-checkpoint.test.ts",
  "test/unit/modules/reading-claim.test.ts",
  "test/unit/process-reading/commit-terminal.test.ts",
  "test/unit/process-reading/mark-failed.test.ts",
  "test/unit/queue/dead-letter.test.ts",
  "test/unit/queue/dispatch.test.ts",
  "test/unit/queue/relationship-refresh.test.ts",
  "test/unit/reading-visibility/visibility.test.ts",
  "test/unit/stores/list-index.test.ts",
  "test/unit/stores/reading-store.test.ts",
];

export default [
  defineWorkersProject({
    test: {
      name: "workers",
      // Lease acquire/presentLease add DO round-trips on every processReading.
      // GitHub Actions workers-pool regularly exceeds Vitest's 5s default
      // (two-tenant save-to-ready and MCP import+poll timed out at 5000ms).
      testTimeout: 20_000,
      include: ["test/integration/**/*.test.ts", ...WORKERS_RUNTIME_UNIT_TESTS],
      exclude: ["test/integration/account-deletion-guard-storage.test.ts"],
      setupFiles: ["./test/apply-control-plane.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.test.toml" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            hyperdrives,
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
              X_API_BEARER_TOKEN: "test-x-token",
              RESEND_API_KEY: "test-resend-key",
              TENANT_DATA_PLANE: "1",
            },
          },
        },
      },
    },
  }),
  // Direct `runInDurableObject()` inspection currently leaves a SQLite WAL
  // sidecar behind when the workers pool tries to pop per-test isolated
  // storage. Keep the one runtime-storage evidence file in its own serial
  // storage universe; it owns and clears every fixture object it creates.
  defineWorkersProject({
    test: {
      name: "workers-do-storage",
      testTimeout: 20_000,
      include: ["test/integration/account-deletion-guard-storage.test.ts"],
      setupFiles: ["./test/apply-control-plane.ts"],
      poolOptions: {
        workers: {
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.test.toml" },
          miniflare: {
            compatibilityFlags: ["nodejs_compat"],
            hyperdrives,
            bindings: {
              READER_API_TOKEN: "test-token",
              AUTH_ROOT_SECRET,
              FOUNDER_EMAIL: "founder@test.example",
              TEST_MIGRATIONS: migrations,
              ANTHROPIC_API_KEY: "test-anthropic-key",
              OPENAI_API_KEY: "test-openai-key",
              X_API_BEARER_TOKEN: "test-x-token",
              RESEND_API_KEY: "test-resend-key",
              TENANT_DATA_PLANE: "1",
            },
          },
        },
      },
    },
  }),
  defineProject({
    test: {
      name: "node",
      include: ["test/unit/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...WORKERS_RUNTIME_UNIT_TESTS],
      environment: "node",
    },
  }),
];
