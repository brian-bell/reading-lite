// Registry coverage: every supported corpus workflow must have exactly one
// native route under `ops corpus` with a safety classification and help, and
// no retired top-level entry point may linger as an alternate interface.
// Adding a corpus workflow means adding it to SUPPORTED_CORPUS_WORKFLOWS and
// registering its command — this test fails when either side is missing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../../../scripts/ops-lib/registry";

const SUPPORTED_CORPUS_WORKFLOWS = [
  "audit",
  "recover",
  "ingest",
  "drop",
  "sweep",
  "delete-orphans",
  "backfill-similarity",
  "backfill-vectors",
  "normalize-tags",
  "rebuild-list",
];

const repoRoot = path.resolve(__dirname, "../../..");

describe("ops registry coverage — corpus group", () => {
  it("registers every supported corpus workflow with a safety classification", () => {
    for (const name of SUPPORTED_CORPUS_WORKFLOWS) {
      const cmd = defaultRegistry.commands.find((c) => c.group === "corpus" && c.name === name);
      expect(cmd, `missing native command: corpus ${name}`).toBeDefined();
      expect(["read-only", "plan-first"]).toContain(cmd!.safety);
      expect(cmd!.helpText.length).toBeGreaterThan(0);
      expect(cmd!.summary.length).toBeGreaterThan(0);
    }
  });

  it("registers no corpus command outside the supported list", () => {
    const registered = defaultRegistry.commands.filter((c) => c.group === "corpus").map((c) => c.name);
    expect(registered.sort()).toEqual([...SUPPORTED_CORPUS_WORKFLOWS].sort());
  });

  it("leaves no corpus package alias behind", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const corpusAliases = Object.keys(pkg.scripts).filter((s) => s.startsWith("corpus-"));
    expect(corpusAliases).toEqual([]);
  });

  it("leaves no top-level corpus entry-point script behind", async () => {
    const entries = await fs.readdir(path.join(repoRoot, "scripts"));
    const corpusScripts = entries.filter((e) => /^corpus-.*\.ts$/.test(e));
    expect(corpusScripts).toEqual([]);
  });
});
