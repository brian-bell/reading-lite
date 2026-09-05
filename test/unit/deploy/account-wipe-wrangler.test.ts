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
  // while it stays STRICTLY BELOW the queue's max_retries. Not every retry
  // spends an attempt: the +120s first-confirmation deferral retries without
  // counting one (S6 defect D2) and so does any transient D1/R2/Vectorize
  // error, so an equal budget dead-letters a healthy wipe before the bound
  // trips — the loop the bound exists to avoid. Raise the constant or
  // max_retries alone and this fails, which is the point.
  it("leaves the wipe queue retry headroom above the probe attempt bound", () => {
    const wrangler = read("wrangler.toml");
    const source = read("src/account-wipe.ts");
    const bound = /ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS = (\d+)/.exec(source)?.[1];
    expect(bound).toBeDefined();
    for (const queue of ["reading-lite-wipe", "reading-lite-staging-wipe"]) {
      const block = new RegExp(`queue = "${queue}"[\\s\\S]*?max_retries = (\\d+)`).exec(wrangler);
      expect(block, `${queue} consumer max_retries`).not.toBeNull();
      // One spare for the deferral, one for a blip.
      expect(Number(block![1]), `${queue} consumer max_retries`).toBeGreaterThanOrEqual(
        Number(bound) + 2,
      );
    }
  });

  // Both fan-out and the job skip with `no_tenant_prefix` while
  // TENANT_DATA_PLANE is off, so an environment without the pin cannot run the
  // destructive path at all — including the staging rehearsal issue #203 asks
  // for. Dropping the pin from either deployed environment is therefore a
  // silent loss of the wipe, not a config tidy-up.
  //
  // Rolling the gate back off IS a supported path (docs/operations.md,
  // "Rehearsing account deletion on staging"). The corpus migration copies
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

  // The S6 rehearsal runbook is the operator-facing pin contract: rolling the
  // gate back after writes is not free, rescue must clear deleting_at_ms,
  // fencing a signed-up tenant must revoke credentials, and teardown must
  // use the automatic teardown path.
  it("documents the staging pin rollback, rescue, fence, and teardown procedures", () => {
    const wrangler = read("wrangler.toml");
    const stagingVars = /\[env\.staging\.vars\]([\s\S]*?)\n\[/.exec(wrangler);
    expect(stagingVars, "[env.staging.vars] block").not.toBeNull();
    expect(stagingVars![1]).toMatch(/reverse reconcili/i);

    const ops = read("docs/operations.md");
    const rehearsal = ops.split("### Rehearsing account deletion on staging")[1];
    expect(rehearsal, "rehearsal section").toBeDefined();
    const section = rehearsal!.split("\n## ")[0];

    expect(section).toMatch(/complete rollback only before post-pin writes resume/i);
    expect(section).toMatch(/reverse reconcili/i);
    expect(section).toMatch(/deleting_at_ms=NULL/);
    expect(section).toMatch(/COALESCE\(deleting_at_ms/);
    expect(section).toMatch(/heartbeat is advisory/i);
    expect(section).toMatch(/Pause cron fan-out and teardown/i);
    expect(section).toMatch(/delayed retries/i);
    expect(section).toMatch(/first_completed_at_ms IS NULL/);
    expect(section).toMatch(/DELETE \/api\/account/);
    expect(section).toMatch(/revocation_reason='account_delete'/);
    expect(section).toMatch(/Control-plane teardown is automatic/);
    expect(section).toMatch(/completed_user_id/);
    expect(section).toMatch(/account_deletions/);
    expect(section).toMatch(/account residue-scan/);
    // Instructions must not restore the pre-S4 manual teardown commands.
    expect(section).not.toMatch(/--command "DELETE FROM (?:users|sessions|api_tokens|auth_challenges)/);
  });
});
