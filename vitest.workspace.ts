import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults, defineProject } from "vitest/config";
import { ESSENTIAL_NODE_FILES, ESSENTIAL_WORKERS_FILES } from "./test/ci-scope";
import { hostEnv, testDatabaseUrl } from "./test/helpers/test-database";

const AUTH_ROOT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
// which skips the per-file database clone and founder bootstrap in
// test/apply-control-plane.ts that dominates the workers pool's wall time.
// Integration tests always run on workerd.
const essentialScope = hostEnv().CI_SCOPE === "essential";

export const WORKERS_RUNTIME_UNIT_TESTS = [
  "test/unit/extractor/safe-fetch.test.ts",
  "test/unit/intake/activation.test.ts",
  "test/unit/intake/intake.test.ts",
  "test/unit/process-reading/mark-failed.test.ts",
  "test/unit/queue/dead-letter.test.ts",
  "test/unit/queue/dispatch.test.ts",
  "test/unit/queue/relationship-refresh.test.ts",
];

export default [
  defineWorkersProject({
    test: {
      name: "workers",
      // Lease acquire/presentLease add DO round-trips on every processReading,
      // and since the control plane moved to PostgreSQL (ADR 0005) every
      // request in this pool also makes real database round-trips. GitHub
      // Actions runs the result about 10x slower than a developer machine:
      // comparing the same 347 tests locally against run 35476189924, the
      // median is 9.9x and the tail reaches 30x, while `transform` and
      // `collect` — the pure-CPU phases — are only ~2x apart. The gap is I/O
      // against the service-container database, not the runner's CPU.
      //
      // That first pushed this past Vitest's 5s default (two-tenant
      // save-to-ready and MCP import+poll timed out at 5000ms), and then past
      // 20s: on that run 14 tests took over 15s and the slowest to pass took
      // 21.5s, so the ceiling was inside the normal spread rather than above
      // it. 60s sits clear of the observed tail. Raise it again only for a
      // measured shift like this one; a single test that suddenly needs more
      // is a bug in the test, not a slow runner.
      //
      // Hooks make the same round-trips: test/apply-control-plane.ts truncates
      // the control plane and re-bootstraps the founder before every test, and
      // Vitest's 10s hook default is inside that spread (run 35856362237 timed
      // it out in auth-sessions.test.ts).
      testTimeout: 60_000,
      hookTimeout: 60_000,
      include: essentialScope
        ? [...ESSENTIAL_WORKERS_FILES]
        : ["test/integration/**/*.test.ts", ...WORKERS_RUNTIME_UNIT_TESTS],
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
      // Same runner arithmetic as the `workers` project above.
      testTimeout: 60_000,
      hookTimeout: 60_000,
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
      include: essentialScope ? [...ESSENTIAL_NODE_FILES] : ["test/unit/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...WORKERS_RUNTIME_UNIT_TESTS],
      environment: "node",
    },
  }),
];
