import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadSidecar, saveSidecar } from "../../../../scripts/corpus-lib/batch/sidecar";
import type { ActivatingSidecar, Sidecar } from "../../../../scripts/corpus-lib/batch/types";

const target = {
  customId: "rd_a",
  keyPrefix: "readings/kp",
  id: "rd_a",
  url: "https://example.com/a",
  urlHash: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceType: "markdown" as const,
  contentType: "text/markdown; charset=utf-8",
  contentStatus: "captured",
  contentBytes: 10,
  contentSha256: "b".repeat(64),
  queryEmbedTokens: 0,
};

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), "reading-lite-sidecar-"));
  return { dir, path: join(dir, "index.batch.json") };
}

describe("batch sidecar I/O", () => {
  it("saves through a valid persisted sidecar and loads it back", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar: Sidecar = {
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [target],
      };
      await saveSidecar(path, sidecar);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ batchId: "msgbatch_1" });
      await expect(loadSidecar(path)).resolves.toMatchObject({ batchId: "msgbatch_1" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts an activating sidecar marker", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar: ActivatingSidecar = {
        batchId: "",
        model: "m",
        processingStatus: "activating",
        resultsUrl: null,
        targets: [
          {
            id: "rd_a",
            customId: "rd_a",
            keyPrefix: "readings/kp",
            url: "https://example.com/a",
            urlHash: "a".repeat(64),
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      await saveSidecar(path, sidecar);
      await expect(loadSidecar(path)).resolves.toMatchObject({ processingStatus: "activating" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null only when the sidecar is absent", async () => {
    const { dir, path } = await tempPath();
    try {
      await expect(loadSidecar(path)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed JSON or invalid sidecar shape", async () => {
    const { dir, path } = await tempPath();
    try {
      await writeFile(path, "{");
      await expect(loadSidecar(path)).rejects.toThrow(/manual reconciliation required/);

      await writeFile(path, JSON.stringify({ batchId: "", processingStatus: "mystery", targets: [] }));
      await expect(loadSidecar(path)).rejects.toThrow(/manual reconciliation required/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
