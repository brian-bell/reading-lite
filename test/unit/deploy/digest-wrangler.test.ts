import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("digest wrangler wiring", () => {
  it("schedules */15 cron on staging and production only", () => {
    const wrangler = read("wrangler.toml");
    const testToml = read("wrangler.test.toml");
    expect(wrangler).toMatch(/\[env\.staging\.triggers\]\s*crons = \["\*\/15 \* \* \* \*", "7 3 \* \* \*"\]/);
    expect(wrangler).toMatch(/\[env\.production\.triggers\]\s*crons = \["\*\/15 \* \* \* \*", "7 3 \* \* \*"\]/);
    expect(wrangler).not.toMatch(/^\[triggers\]/m);
    expect(testToml).not.toContain("crons");
    expect(testToml).not.toMatch(/binding = "DIGEST_JOBS"/);
  });

  it("binds DIGEST_JOBS to dedicated queues, not READING_JOBS", () => {
    const wrangler = read("wrangler.toml");
    expect(wrangler).toContain('binding = "DIGEST_JOBS"');
    expect(wrangler).toContain('queue = "reading-lite-digest"');
    expect(wrangler).toContain('queue = "reading-lite-staging-digest"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-digest-dlq"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-staging-digest-dlq"');
    expect(wrangler).toMatch(/queue = "reading-lite-digest"\s*\nmax_batch_size = 1/);
    expect(wrangler).toMatch(/queue = "reading-lite-staging-digest"\s*\nmax_batch_size = 1/);
  });
});
