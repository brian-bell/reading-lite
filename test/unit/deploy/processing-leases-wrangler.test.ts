import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GlobalUsageGuard wrangler wiring", () => {
  it("declares v3 sqlite class and GLOBAL_USAGE_GUARD identically in every wrangler config", () => {
    const files = ["wrangler.toml", "wrangler.test.toml"].map((path) => read(path));
    for (const text of files) {
      expect(text).toMatch(/tag = "v3"\s*\nnew_sqlite_classes = \["GlobalUsageGuard"\]/);
      expect(text).toContain('name = "GLOBAL_USAGE_GUARD"');
      expect(text).toContain('class_name = "GlobalUsageGuard"');
    }
    const wrangler = files[0]!;
    expect(wrangler.match(/name = "GLOBAL_USAGE_GUARD"/g)).toHaveLength(3);
    expect(wrangler.match(/class_name = "GlobalUsageGuard"/g)).toHaveLength(3);
  });
});
