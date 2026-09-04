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
    expect(read("src/account-wipe.ts")).not.toMatch(/READING_JOBS/);
    expect(read("src/control-plane/account-handlers.ts")).not.toMatch(/account-wipe/);
    expect(read("src/control-plane/account-delete.ts")).not.toMatch(/account-wipe/);
  });

  // The terminal probe bound is only consumed inside one message's retry budget
  // while it stays <= the queue's max_retries. Raise max_retries or the constant
  // alone and every probe hit starts dead-lettering before the bound trips,
  // which is the loop the bound exists to avoid.
  it("keeps the probe attempt bound within the wipe queue's retry budget", () => {
    const wrangler = read("wrangler.toml");
    const source = read("src/account-wipe.ts");
    const bound = /ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS = (\d+)/.exec(source)?.[1];
    expect(bound).toBeDefined();
    for (const queue of ["reading-lite-wipe", "reading-lite-staging-wipe"]) {
      const block = new RegExp(`queue = "${queue}"[\\s\\S]*?max_retries = (\\d+)`).exec(wrangler);
      expect(block, `${queue} consumer max_retries`).not.toBeNull();
      expect(Number(bound)).toBeLessThanOrEqual(Number(block![1]));
    }
  });

  // Both fan-out and the job skip with `no_tenant_prefix` while
  // TENANT_DATA_PLANE is off, so an environment without the pin cannot run the
  // destructive path at all — including the staging rehearsal issue #203 asks
  // for. Dropping the pin from either deployed environment is therefore a
  // silent loss of the wipe, not a config tidy-up.
  //
  // Rolling the gate back off IS a supported path (docs/operations.md,
  // "Rehearsing account deletion on staging" — the corpus migration copies
  // rather than moves, so the pre-tenant objects are still there). It is just
  // not a silent one: a rollback commit must relax this assertion for the
  // environment it rolls back, in the same commit, which is the point.
  it("pins the tenant data plane in every environment the wipe queue is wired into", () => {
    const wrangler = read("wrangler.toml");
    for (const env of ["staging", "production"]) {
      const vars = new RegExp(`\\[env\\.${env}\\.vars\\]([\\s\\S]*?)\\n\\[`).exec(wrangler);
      expect(vars, `[env.${env}.vars] block`).not.toBeNull();
      expect(vars![1]).toMatch(/^TENANT_DATA_PLANE = "1"$/m);
    }
  });
});
