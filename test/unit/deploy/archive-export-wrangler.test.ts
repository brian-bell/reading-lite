import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("archive export wrangler wiring", () => {
  it("binds ARCHIVE_EXPORT_JOBS to a shared queue with a dead-letter queue in staging and production", () => {
    const wrangler = read("wrangler.toml");
    const testToml = read("wrangler.test.toml");
    expect(wrangler).toContain('binding = "ARCHIVE_EXPORT_JOBS"');
    expect(wrangler).toContain('queue = "reading-lite-export"');
    expect(wrangler).toContain('queue = "reading-lite-staging-export"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-export-dlq"');
    expect(wrangler).toContain('dead_letter_queue = "reading-lite-staging-export-dlq"');
    expect(wrangler).toMatch(/queue = "reading-lite-export"\s*\nmax_batch_size = 1/);
    expect(wrangler).toMatch(/queue = "reading-lite-staging-export"\s*\nmax_batch_size = 1/);
    // One delivery at a time: a redelivered segment rewrites its fixed key,
    // which is only safe while no two deliveries of an export overlap.
    for (const queue of ["reading-lite-export", "reading-lite-staging-export"]) {
      expect(wrangler).toMatch(
        new RegExp(`\\[\\[env\\.\\w+\\.queues\\.consumers\\]\\]\\nqueue = "${queue}"\\n(?:\\w+ = .*\\n)*?max_concurrency = 1\\n`),
      );
    }
    expect(testToml).not.toMatch(/binding = "ARCHIVE_EXPORT_JOBS"/);
  });
});
