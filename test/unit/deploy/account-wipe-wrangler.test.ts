import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("account wipe wrangler wiring", () => {
  it("binds ACCOUNT_WIPE_JOBS to a shared queue, not READING_JOBS or a per-tenant worker", () => {
    const wrangler = read("wrangler.toml");
    const testToml = read("wrangler.test.toml");
    expect(wrangler).toContain('binding = "ACCOUNT_WIPE_JOBS"');
    expect(wrangler).toContain('queue = "reading-lite-wipe"');
    expect(wrangler).toContain('queue = "reading-lite-staging-wipe"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-wipe-dlq"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-staging-wipe-dlq"');
    expect(wrangler).toMatch(/queue = "reading-lite-wipe"\s*\nmax_batch_size = 1/);
    expect(wrangler).toMatch(/queue = "reading-lite-staging-wipe"\s*\nmax_batch_size = 1/);
    expect(testToml).not.toMatch(/binding = "ACCOUNT_WIPE_JOBS"/);
  });

  // Both fan-out and the job skip with `no_tenant_prefix` while
  // TENANT_DATA_PLANE is off, so an environment without the pin cannot run the
  // destructive path at all — including the staging rehearsal issue #203 asks
  // for. Dropping the pin from either deployed environment is therefore a
  // silent loss of the wipe, not a config tidy-up.
  //
  // Rolling the gate back off IS a supported path. The corpus migration copies
  // rather than moves, so the pre-tenant objects are still there — but that is
  // a complete rollback only before post-pin writes resume. After writes,
  // rollback needs a freeze plus reverse reconciliation, or an explicit
  // acceptance of loss. A rollback commit must also relax this assertion for
  // the environment it rolls back, in the same commit.
  it("pins the tenant data plane in every environment the wipe queue is wired into", () => {
    const wrangler = read("wrangler.toml");
    for (const env of ["staging", "production"]) {
      const vars = new RegExp(`\\[env\\.${env}\\.vars\\]([\\s\\S]*?)\\n\\[`).exec(wrangler);
      expect(vars, `[env.${env}.vars] block`).not.toBeNull();
      expect(vars![1]).toMatch(/^TENANT_DATA_PLANE = "1"$/m);
    }
  });
});
