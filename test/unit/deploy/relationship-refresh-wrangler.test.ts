import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("relationship refresh deployment", () => {
  const config = readFileSync("wrangler.toml", "utf8");
  for (const [env, queue] of [["staging", "reading-lite-staging-refresh"], ["production", "reading-lite-refresh"]]) {
    it(`wires an isolated queue pair with the rollout gate for ${env}`, () => {
      const sections = config.split(/(?=^\[)/m);
      expect(sections).toContainEqual(expect.stringContaining(
        `[[env.${env}.queues.producers]]\nbinding = "RELATIONSHIP_REFRESH_JOBS"\nqueue = "${queue}"`,
      ));
      const consumer = sections.find(s => s.startsWith(`[[env.${env}.queues.consumers]]\nqueue = "${queue}"`));
      expect(consumer).toContain(`dead_letter_queue = "${queue}-dlq"`);
      expect(consumer).toContain("max_concurrency = 1");
      const dlq = sections.find(s => s.startsWith(`[[env.${env}.queues.consumers]]\nqueue = "${queue}-dlq"`));
      expect(dlq).toBeDefined();
      expect(dlq).not.toContain("dead_letter_queue =");
      const vars = sections.find(s => s.startsWith(`[env.${env}.vars]`));
      const cap = env === "production" ? "100" : "2";
      expect(vars).toContain(`REFRESH_MAX_JUDGEMENTS = "${cap}"`);
      expect(vars).toContain(`REFRESH_MAX_TENSION_JUDGEMENTS = "${cap}"`);
      expect(vars).toMatch(/^RELATIONSHIP_REFRESH = "1"$/m);
    });
  }
  it("does not bind refresh queues locally or in tests", () => {
    expect(config.split("[env.staging]")[0]).not.toContain('binding = "RELATIONSHIP_REFRESH_JOBS"');
    expect(readFileSync("wrangler.test.toml", "utf8")).not.toContain('binding = "RELATIONSHIP_REFRESH_JOBS"');
  });
});
