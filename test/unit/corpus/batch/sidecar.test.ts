import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  clearInputJsonl,
  clearSidecar,
  inputJsonlPath,
  loadInputJsonl,
  loadSidecar,
  saveInputJsonl,
  saveSidecar,
} from "../../../../scripts/corpus-lib/batch/sidecar";
import type {
  ActivatingSidecar,
  OpenAISubmittedSidecar,
  PersistedSidecar,
  Sidecar,
} from "../../../../scripts/corpus-lib/batch/types";

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
  it("round-trips a complete target attempt identity", async () => {
    const { dir, path } = await tempPath();
    try {
      const attemptedTarget = {
        ...target,
        attemptId: "at_batch_1",
        attemptStartedAt: "2026-06-22T12:00:00.000Z",
        trigger: "reprocess" as const,
      };
      const sidecar: Sidecar = {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [attemptedTarget],
      };
      await saveSidecar(path, sidecar);
      await expect(loadSidecar(path)).resolves.toMatchObject({
        targets: [attemptedTarget],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a partial target attempt identity", async () => {
    const { dir, path } = await tempPath();
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          provider: "anthropic",
          phase: "submitted",
          batchId: "msgbatch_1",
          model: "m",
          processingStatus: "in_progress",
          resultsUrl: null,
          targets: [{ ...target, attemptId: "at_incomplete" }],
        }),
      );
      await expect(loadSidecar(path)).rejects.toThrow(/attempt identity/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the tenant selector stamp (s1k.4.3 resume pinning)", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar = {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [target],
        tenant: "usr_550e8400-e29b-41d4-a716-446655440000",
      } as Sidecar;
      await saveSidecar(path, sidecar);
      const loaded = await loadSidecar(path);
      expect(loaded?.tenant).toBe("usr_550e8400-e29b-41d4-a716-446655440000");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saves through a valid persisted sidecar and loads it back", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar = {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [target],
      } as Sidecar;
      await saveSidecar(path, sidecar);
      const expected = {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        targets: [target],
      };
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(expected);
      await expect(loadSidecar(path)).resolves.toMatchObject(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips judged candidate IDs and still loads a pre-upgrade sidecar without them", async () => {
    const { dir, path } = await tempPath();
    try {
      const withIds = {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [{ ...target, neighbourhoodIds: ["rd_b", "rd_c"] }],
      } as Sidecar;
      await saveSidecar(path, withIds);
      await expect(loadSidecar(path)).resolves.toMatchObject({
        targets: [{ neighbourhoodIds: ["rd_b", "rd_c"] }],
      });

      await saveSidecar(path, {
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_1",
        model: "m",
        processingStatus: "in_progress",
        resultsUrl: null,
        targets: [target],
      } as Sidecar);
      const loaded = await loadSidecar(path);
      expect(loaded && "targets" in loaded ? loaded.targets[0] : undefined).not.toHaveProperty(
        "neighbourhoodIds",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saves and loads a submitted OpenAI sidecar with pinned provider state", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar: OpenAISubmittedSidecar = {
        version: 2,
        provider: "openai",
        phase: "submitted",
        runId: "run_1",
        batchId: "batch_1",
        inputFileId: "file_input",
        outputFileId: "file_output",
        errorFileId: null,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        processingStatus: "completed",
        targets: [target],
      };

      await saveSidecar(path, sidecar);
      await expect(loadSidecar(path)).resolves.toEqual(sidecar);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts only phase-consistent OpenAI pre-submit checkpoints", async () => {
    const { dir, path } = await tempPath();
    try {
      const identity = {
        version: 2 as const,
        provider: "openai" as const,
        runId: "run_1",
        batchId: "" as const,
        model: "gpt-5.6-terra",
        reasoningEffort: "low" as const,
        outputFileId: null,
        errorFileId: null,
      };
      const activatingTarget = {
        id: "rd_a",
        customId: "rd_a",
        keyPrefix: "readings/kp",
        url: "https://example.com/a",
        urlHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const checkpoints = [
        {
          ...identity,
          phase: "activating",
          inputFileId: null,
          processingStatus: "activating",
          targets: [activatingTarget],
        },
        {
          ...identity,
          phase: "uploading",
          inputFileId: null,
          processingStatus: "uploading",
          targets: [target],
        },
        {
          ...identity,
          phase: "creating",
          inputFileId: "file_input",
          processingStatus: "creating",
          targets: [target],
        },
      ] as unknown as PersistedSidecar[];

      for (const checkpoint of checkpoints) {
        await saveSidecar(path, checkpoint);
        await expect(loadSidecar(path)).resolves.toEqual(checkpoint);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an OpenAI uploading sidecar with an activating checkpoint", async () => {
    const { dir, path } = await tempPath();
    try {
      const uploading: PersistedSidecar = {
        version: 2,
        provider: "openai",
        phase: "uploading",
        runId: "run_holder",
        batchId: "",
        inputFileId: null,
        outputFileId: null,
        errorFileId: null,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        processingStatus: "uploading",
        targets: [target],
      };
      await saveSidecar(path, uploading);
      await expect(
        saveSidecar(path, {
          ...uploading,
          phase: "activating",
          runId: "run_other",
          processingStatus: "activating",
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
        }),
      ).rejects.toThrow(/refusing to overwrite/i);
      await expect(loadSidecar(path)).resolves.toMatchObject({
        phase: "uploading",
        runId: "run_holder",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts an activating sidecar marker", async () => {
    const { dir, path } = await tempPath();
    try {
      const sidecar: ActivatingSidecar = {
        version: 2,
        provider: "anthropic",
        phase: "activating",
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

  it("infers an unversioned submitted sidecar as Anthropic V2", async () => {
    const { dir, path } = await tempPath();
    try {
      await writeFile(
        path,
        JSON.stringify({
          batchId: "msgbatch_legacy",
          model: "legacy-model",
          processingStatus: "pending",
          resultsUrl: null,
          targets: [target],
        }),
      );

      await expect(loadSidecar(path)).resolves.toMatchObject({
        version: 2,
        provider: "anthropic",
        phase: "submitted",
        batchId: "msgbatch_legacy",
        model: "legacy-model",
        targets: [target],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("infers unversioned no-id checkpoints without changing their crash phase", async () => {
    const { dir, path } = await tempPath();
    try {
      const activatingTarget = {
        id: "rd_a",
        customId: "rd_a",
        keyPrefix: "readings/kp",
        url: "https://example.com/a",
        urlHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      for (const checkpoint of [
        {
          processingStatus: "activating",
          expectedPhase: "activating",
          targets: [activatingTarget],
        },
        {
          processingStatus: "pending",
          expectedPhase: "creating",
          targets: [target],
        },
      ]) {
        await writeFile(
          path,
          JSON.stringify({
            batchId: "",
            model: "legacy-model",
            processingStatus: checkpoint.processingStatus,
            resultsUrl: null,
            targets: checkpoint.targets,
          }),
        );

        await expect(loadSidecar(path)).resolves.toMatchObject({
          version: 2,
          provider: "anthropic",
          phase: checkpoint.expectedPhase,
          batchId: "",
          model: "legacy-model",
        });
      }
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

  it("fails closed instead of reinterpreting an unsupported V2 provider", async () => {
    const { dir, path } = await tempPath();
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          provider: "openai",
          phase: "submitted",
          batchId: "batch_wrong_provider",
          model: "m",
          processingStatus: "completed",
          resultsUrl: null,
          targets: [target],
        }),
      );

      await expect(loadSidecar(path)).rejects.toThrow(
        /manual reconciliation required/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to persist a sidecar with invalid V2 identity", async () => {
    const { dir, path } = await tempPath();
    try {
      const invalid = {
        version: 2,
        provider: "openai",
        phase: "submitted",
        batchId: "batch_wrong_provider",
        model: "m",
        processingStatus: "completed",
        resultsUrl: null,
        targets: [target],
      };

      await expect(
        saveSidecar(path, invalid as unknown as Sidecar),
      ).rejects.toThrow();
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

describe("batch sidecar companion JSONL", () => {
  it("derives the companion path from the sidecar path", () => {
    expect(inputJsonlPath("/tmp/index.batch.json")).toBe("/tmp/index.batch.input.jsonl");
    expect(inputJsonlPath("./corpus-ingest.batch.json")).toBe(
      "./corpus-ingest.batch.input.jsonl",
    );
  });

  it("round-trips exact bytes including a trailing newline", async () => {
    const { dir, path } = await tempPath();
    try {
      const jsonl = '{"custom_id":"rd_a"}\n';
      await saveInputJsonl(path, jsonl);
      expect(await readFile(inputJsonlPath(path), "utf8")).toBe(jsonl);
      await expect(loadInputJsonl(path)).resolves.toBe(jsonl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the companion file is missing", async () => {
    const { dir, path } = await tempPath();
    try {
      await expect(loadInputJsonl(path)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clearSidecar also removes the companion JSONL", async () => {
    const { dir, path } = await tempPath();
    try {
      await saveInputJsonl(path, '{"custom_id":"rd_a"}\n');
      expect(await readFile(inputJsonlPath(path), "utf8")).toBeTruthy();
      await clearSidecar(path);
      await expect(readFile(inputJsonlPath(path), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clearInputJsonl is a no-op when nothing is present", async () => {
    const { dir, path } = await tempPath();
    try {
      await expect(clearInputJsonl(path)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
