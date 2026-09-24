import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Migrates the shared PostgreSQL test database once per run and fails fast
    // when Postgres is unreachable (ADR 0005).
    globalSetup: ["./test/global-setup-postgres.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
