import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlaywright } from "../../../scripts/extract-agent-lib/playwright";

const REPO_ROOT = join(__dirname, "../../..");

function listTsFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      return listTsFilesRecursive(fullPath);
    }
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("extract-agent scaffolding", () => {
  it("wires the extract-agent npm script to the stub CLI entrypoint", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts["extract-agent"]).toBe("tsx scripts/extract-agent.ts");
  });

  it("exposes a lazy playwright seam that resolves chromium.launch", async () => {
    const playwright = await loadPlaywright();
    expect(typeof playwright.chromium.launch).toBe("function");
  });

  it("never imports playwright from src/, so it is never bundled into the Worker", () => {
    const srcFiles = listTsFilesRecursive(join(REPO_ROOT, "src"));
    const offenders = srcFiles.filter((file) => /['"]playwright['"]/.test(readFileSync(file, "utf-8")));
    expect(offenders).toEqual([]);
  });
});
