import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Pages SPA fallback", () => {
  it("rewrites unknown paths including /auth/verify to index.html", () => {
    const redirects = readFileSync(path.join(process.cwd(), "web/public/_redirects"), "utf8");
    expect(redirects).toMatch(/\/\*\s+\/index\.html\s+200/);
    expect(redirects).toMatch(/auth\/verify/);
  });
});
