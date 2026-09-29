import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESSENTIAL_NODE_FILES, ESSENTIAL_WORKERS_FILES } from "../../ci-scope";
import { WORKERS_RUNTIME_UNIT_TESTS } from "../../../vitest.workspace";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workersFiles: readonly string[] = ESSENTIAL_WORKERS_FILES;
const nodeFiles: readonly string[] = ESSENTIAL_NODE_FILES;

describe("essential CI scope", () => {
  it("names files that exist", () => {
    const missing = [...workersFiles, ...nodeFiles].filter((file) => !existsSync(path.join(repoRoot, file)));
    expect(missing).toEqual([]);
  });

  it("keeps the workers-runtime unit tests on the workers list and off the node list", () => {
    expect(WORKERS_RUNTIME_UNIT_TESTS.filter((file) => !workersFiles.includes(file))).toEqual([]);
    expect(nodeFiles.filter((file) => WORKERS_RUNTIME_UNIT_TESTS.includes(file))).toEqual([]);
  });

  it("names the split contract files and leaves the catalogs off the essential lists", () => {
    expect(workersFiles).toContain("test/integration/account-deletion-guard-storage.test.ts");
    expect(workersFiles).toContain("test/integration/readings-contract.test.ts");
    expect(workersFiles).not.toContain("test/integration/readings.test.ts");
    expect(nodeFiles).toContain("test/unit/corpus/batch/sidecar-before-create.test.ts");
    expect(nodeFiles).not.toContain("test/unit/corpus/batch/run.test.ts");
    expect(nodeFiles).not.toContain("test/unit/lib/wrangler-cli.test.ts");
  });
});
