import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sidecarPath, loadSidecar, saveSidecar, clearSidecar } from "../../../../scripts/corpus-lib/batch/sidecar";
import type { Sidecar } from "../../../../scripts/corpus-lib/batch/types";

describe("sidecarPath", () => {
  it("derives the batch sidecar path next to the index", () => {
    expect(sidecarPath("./index.json")).toBe("./index.batch.json");
    expect(sidecarPath("/tmp/audit.JSON")).toBe("/tmp/audit.batch.json");
    expect(sidecarPath("noext")).toBe("noext.batch.json");
  });
});

describe("sidecar load/save/clear", () => {
  let dir: string;
  let file: string;
  const sample: Sidecar = {
    batchId: "msgbatch_1",
    model: "m",
    processingStatus: "in_progress",
    resultsUrl: null,
    // A real in-flight sidecar always carries at least one target (submit is
    // skipped when there are zero), so the round-trip fixture must too.
    targets: [
      {
        customId: "c1",
        keyPrefix: "readings/2026/06/22T120000Z-rd_1",
        id: "rd_1",
        url: "https://example.com/a",
        urlHash: "a".repeat(64),
        createdAt: "2026-06-22T12:00:00.000Z",
        sourceType: "markdown",
        contentType: "text/markdown; charset=utf-8",
        contentStatus: "captured",
        contentBytes: 4,
        contentSha256: "b".repeat(64),
        queryEmbedTokens: 7,
      },
    ],
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-"));
    file = path.join(dir, "x.batch.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when absent", async () => {
    expect(await loadSidecar(file)).toBeNull();
  });

  it("round-trips a saved sidecar", async () => {
    await saveSidecar(file, sample);
    expect(await loadSidecar(file)).toEqual(sample);
  });

  it("fails closed (throws) on a malformed/truncated sidecar — never silently 'absent'", async () => {
    // A crash mid-write can leave a corrupt sidecar after the batch was billed;
    // treating it as absent would resubmit a second (double-billed) batch.
    await fs.writeFile(file, '{"batchId":"msgbatch_1","tar');
    await expect(loadSidecar(file)).rejects.toThrow(/unreadable\/malformed/i);
  });

  it("fails closed on valid JSON that is not a sidecar object (null/primitive/array/missing fields)", async () => {
    // A file that parses but is not a real Sidecar must NOT be treated as absent —
    // `null` in particular would slip past `if (existing)` and resubmit a second,
    // double-billed batch. Fail closed for any non-Sidecar JSON.
    for (const bad of ["null", "123", '"x"', "[]", "{}", '{"batchId":"msgbatch_1"}']) {
      await fs.writeFile(file, bad);
      await expect(loadSidecar(file)).rejects.toThrow(/unreadable\/malformed/i);
    }
  });

  it("fails closed on a resumable-looking sidecar with empty or malformed targets", async () => {
    // A real in-flight batch always has >=1 fully-specified target. An empty-targets
    // or field-missing sidecar that is honored as resumable gets polled, mis-written,
    // then cleared — losing the recovery marker for a billed batch. Fail closed.
    const emptyTargets = JSON.stringify({
      batchId: "msgbatch_x",
      model: "m",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [],
    });
    const badTarget = JSON.stringify({
      batchId: "msgbatch_x",
      model: "m",
      processingStatus: "in_progress",
      resultsUrl: null,
      targets: [{ id: "rd_1" }], // missing customId/keyPrefix/url/etc.
    });
    for (const bad of [emptyTargets, badTarget]) {
      await fs.writeFile(file, bad);
      await expect(loadSidecar(file)).rejects.toThrow(/unreadable\/malformed/i);
    }
  });

  it("clear removes the file (idempotent)", async () => {
    await saveSidecar(file, sample);
    await clearSidecar(file);
    expect(await loadSidecar(file)).toBeNull();
    await clearSidecar(file); // no throw when already gone
  });
});
