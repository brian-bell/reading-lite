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
});
