import { describe, expect, it } from "vitest";
import { corpusDropCommand, type CorpusDropDeps } from "../../../scripts/ops-lib/commands/corpus-drop";
import { corpusSweepCommand, type CorpusSweepDeps } from "../../../scripts/ops-lib/commands/corpus-sweep";
import {
  corpusDeleteOrphansCommand,
  type CorpusDeleteOrphansDeps,
} from "../../../scripts/ops-lib/commands/corpus-delete-orphans";
import {
  corpusBackfillSimilarityCommand,
  type CorpusBackfillDeps,
} from "../../../scripts/ops-lib/commands/corpus-backfill-similarity";
import {
  corpusBackfillVectorsCommand,
  type CorpusBackfillVectorsDeps,
} from "../../../scripts/ops-lib/commands/corpus-backfill-vectors";
import {
  corpusNormalizeTagsCommand,
  type CorpusNormalizeTagsDeps,
} from "../../../scripts/ops-lib/commands/corpus-normalize-tags";
import {
  corpusRebuildListCommand,
  type CorpusRebuildListDeps,
} from "../../../scripts/ops-lib/commands/corpus-rebuild-list";
import { corpusIngestCommand, type CorpusIngestDeps } from "../../../scripts/ops-lib/commands/corpus-ingest";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { ListItem } from "../../../scripts/corpus-lib/types";

function io(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t) }, lines };
}

const FAILED_ITEM: ListItem = {
  id: "rd_f", url: "https://a.example/x", status: "failed",
  created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_f",
};

describe("ops corpus drop", () => {
  function makeDeps(items: ListItem[]) {
    const { io: cio, lines } = io();
    const calls = { deletes: [] as string[], vectorDeletes: [] as string[], indexWrites: 0 };
    const deps: CorpusDropDeps = {
      io: cio,
      r2: {
        readListIndex: async () => items,
        keysForReading: async (id, prefix) => [`${prefix}/manifest.json`, `index/by-id/${id}`],
        deleteObject: async (key) => {
          calls.deletes.push(key);
          return "deleted";
        },
        deleteVector: async (index, id) => {
          calls.vectorDeletes.push(`${index}/${id}`);
          return "deleted";
        },
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode resolves targets and deletes nothing", async () => {
    const { deps, lines, calls } = makeDeps([FAILED_ITEM]);
    const code = await corpusDropCommand.run(["--tenant", "global", "rd_f"], deps);
    expect(code).toBe(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(lines.join("\n")).toContain("would delete  readings/rd_f/manifest.json");
  });

  it("--execute deletes objects and rewrites the index", async () => {
    const { deps, calls } = makeDeps([FAILED_ITEM]);
    const code = await corpusDropCommand.run(["--tenant", "global", "rd_f", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.deletes).toEqual(["readings/rd_f/manifest.json", "index/by-id/rd_f"]);
    expect(calls.indexWrites).toBe(1);
  });

  it("keeps the index intact when an object delete fails", async () => {
    const { deps, calls } = makeDeps([FAILED_ITEM]);
    deps.r2.deleteObject = async () => "error";
    const code = await corpusDropCommand.run(["--tenant", "global", "rd_f", "--execute"], deps);
    expect(code).toBe(1);
    expect(calls.indexWrites).toBe(0);
  });

  it("refuses --allow-ready against the production bucket", async () => {
    const { deps } = makeDeps([FAILED_ITEM]);
    await expect(corpusDropCommand.run(["--tenant", "global", "rd_f", "--allow-ready"], deps)).rejects.toThrow(UsageError);
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps([FAILED_ITEM]);
    await expect(corpusDropCommand.run(["rd_f", "--execute"], deps)).rejects.toThrow(/--tenant is required/);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
  });

  it("requires selectors", async () => {
    const { deps } = makeDeps([FAILED_ITEM]);
    await expect(corpusDropCommand.run(["--tenant", "global"], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops corpus sweep", () => {
  const DUP_ITEMS = [
    {
      id: "rd_keep", url: "https://www.youtube.com/watch?v=abc123def45", status: "ready",
      created_at: "2026-08-02T00:00:00Z", key_prefix: "readings/rd_keep",
      summary: { tldr: "a much richer summary of the video content here" },
    },
    {
      id: "rd_dup", url: "https://youtu.be/abc123def45", status: "ready",
      created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_dup",
      summary: { tldr: "short" },
    },
  ];

  function makeDeps(items: unknown[]) {
    const { io: cio, lines } = io();
    const calls = { deletes: [] as string[], vectorDeletes: [] as string[], indexWrites: 0 };
    const deps: CorpusSweepDeps = {
      io: cio,
      r2: {
        readListIndex: async () => items,
        readManifest: async () => null,
        keysForReading: async (_id, prefix) => [`${prefix}/manifest.json`],
        deleteObject: async (key) => {
          calls.deletes.push(key);
          return "deleted";
        },
        deleteVector: async (index, id) => {
          calls.vectorDeletes.push(`${index}/${id}`);
          return "deleted";
        },
        vectorExists: async () => true,
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode reports groups and would-deletes without acting", async () => {
    const { deps, lines, calls } = makeDeps(DUP_ITEMS);
    const code = await corpusSweepCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.vectorDeletes).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("keep  rd_keep");
    expect(text).toContain("drop  rd_dup");
    expect(text).toContain("would delete vector");
  });

  it("--execute deletes the loser's vector and objects and rewrites the index", async () => {
    const { deps, calls } = makeDeps(DUP_ITEMS);
    const code = await corpusSweepCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.vectorDeletes).toEqual(["reading-lite/rd_dup"]);
    expect(calls.deletes).toEqual(["readings/rd_dup/manifest.json"]);
    expect(calls.indexWrites).toBe(1);
  });

  it("fails closed without --tenant", async () => {
    await expect(corpusSweepCommand.run(["--execute"], makeDeps(DUP_ITEMS).deps)).rejects.toThrow(
      /--tenant is required/,
    );
  });

  it("probes vector existence under the selected tenant namespace", async () => {
    const { deps } = makeDeps(DUP_ITEMS);
    const probes: Array<string | undefined> = [];
    deps.r2.vectorExists = async (_index, _id, namespace) => {
      probes.push(namespace);
      return true;
    };
    const code = await corpusSweepCommand.run(
      ["--tenant", "usr_11111111-1111-4111-8111-111111111111"],
      deps,
    );
    expect(code).toBe(0);
    expect(probes.length).toBeGreaterThan(0);
    expect(new Set(probes)).toEqual(new Set(["usr_11111111-1111-4111-8111-111111111111"]));
  });

  it("tenant mode probes and deletes the ADR-0002 tenant-prefixed vector id", async () => {
    const { deps } = makeDeps(DUP_ITEMS);
    const probes: Array<{ id: string; namespace: string | undefined }> = [];
    const deletes: string[] = [];
    deps.r2.vectorExists = async (_index, id, namespace) => {
      probes.push({ id, namespace });
      return true;
    };
    deps.r2.deleteVector = async (_index, id) => {
      deletes.push(id);
      return "deleted";
    };

    const tenantId = "usr_11111111-1111-4111-8111-111111111111";
    const code = await corpusSweepCommand.run(
      ["--tenant", tenantId, "--execute"],
      deps,
    );

    expect(code).toBe(0);
    expect(probes).toEqual([{ id: `${tenantId}:rd_dup`, namespace: tenantId }]);
    expect(deletes).toEqual([`${tenantId}:rd_dup`]);
  });

  it("--drop requires exactly one --keep and no other selectors", async () => {
    const { deps } = makeDeps(DUP_ITEMS);
    await expect(corpusSweepCommand.run(["--tenant", "global", "--drop", "rd_dup"], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops corpus delete-orphans", () => {
  const LIST = {
    items: [
      { id: "rd_ready", url: "https://a.example/x", status: "ready", key_prefix: "readings/rd_ready", created_at: "2026-08-01T00:00:00Z" },
      { id: "rd_orphan", url: "https://a.example/x", status: "pending", key_prefix: "readings/rd_orphan", created_at: "2026-08-01T00:00:00Z" },
    ],
  };

  function makeDeps() {
    const { io: cio, lines } = io();
    const calls = { deletes: [] as string[], indexWrites: 0 };
    const deps: CorpusDeleteOrphansDeps = {
      io: cio,
      r2: {
        readObject: async () => JSON.stringify(LIST),
        keysForReading: async (id, prefix) => [`${prefix}/manifest.json`, `index/by-id/${id}`],
        deleteObject: async (key) => {
          calls.deletes.push(key);
          return "deleted";
        },
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
      readFile: async () => {
        throw new Error("audit index must not be read in --ids mode");
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode deletes nothing", async () => {
    const { deps, calls, lines } = makeDeps();
    const code = await corpusDeleteOrphansCommand.run(["--tenant", "global", "--ids", "rd_orphan"], deps);
    expect(code).toBe(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(lines.join("\n")).toContain("would delete  readings/rd_orphan/manifest.json");
  });

  it("--execute deletes the orphan and rewrites the index", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusDeleteOrphansCommand.run(["--tenant", "global", "--ids", "rd_orphan", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.deletes).toContain("readings/rd_orphan/manifest.json");
    expect(calls.indexWrites).toBe(1);
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      corpusDeleteOrphansCommand.run(["--ids", "rd_orphan", "--execute"], deps),
    ).rejects.toThrow(/--tenant is required/);
    expect(calls.deletes).toHaveLength(0);
  });

  it("refuses an audit taken under a different tenant", async () => {
    const { deps, calls, lines } = makeDeps();
    deps.readFile = async () =>
      JSON.stringify({ tenant: "usr_11111111-1111-4111-8111-111111111111", rows: [] });
    const code = await corpusDeleteOrphansCommand.run(
      ["--tenant", "global", "--index", "index.json", "--execute"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.deletes).toHaveLength(0);
    expect(lines.join("\n")).toContain("was taken under tenant");
  });

  it("refuses a ready id", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusDeleteOrphansCommand.run(["--tenant", "global", "--ids", "rd_ready", "--execute"], deps);
    expect(code).toBe(1);
    expect(calls.deletes).toHaveLength(0);
  });
});

describe("ops corpus backfill-similarity", () => {
  const READY: ListItem & { similarity?: unknown } = {
    id: "rd_r", url: "https://a.example/x", status: "ready",
    created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_r",
  };

  function makeDeps(matches: { id: string; score: number }[] | null) {
    const { io: cio, lines } = io();
    const calls = { queries: 0, puts: [] as string[], indexWrites: 0 };
    const deps: CorpusBackfillDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [READY],
        readManifest: async () => ({
          id: "rd_r", url: "https://a.example/x", url_hash: "a".repeat(64), status: "ready",
          created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
          content_type: "text/html", content_status: "captured",
          content_bytes: 10, content_sha256: "b".repeat(64),
        }),
        queryByVectorId: async () => {
          calls.queries++;
          return matches;
        },
        putManifest: async (kp) => {
          calls.puts.push(kp);
        },
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
      now: () => Date.parse("2026-08-22T12:00:00Z"),
    };
    return { deps, lines, calls };
  }

  // A failed query costs one reading rather than the pass — a backfill runs for
  // hundreds — but the exit status still has to say the run was incomplete, in
  // plan mode too. Before, the throw propagated and the dispatcher exited
  // non-zero; a cron checking a plan pass must not lose that.
  it("survives a failed query per reading and still reports the run incomplete", async () => {
    const { deps, lines, calls } = makeDeps([{ id: "rd_r", score: 1 }]);
    deps.r2.queryByVectorId = async () => {
      calls.queries++;
      throw new Error("no matches array");
    };
    const code = await corpusBackfillSimilarityCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(1);
    expect(calls.queries).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("vectorize query failed for rd_r");
    expect(text).toContain("run incomplete");
  });

  it("plan mode queries but writes nothing", async () => {
    const { deps, calls } = makeDeps([{ id: "rd_r", score: 1 }, { id: "rd_o", score: 0.5 }]);
    const code = await corpusBackfillSimilarityCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.queries).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
  });

  it("tenant mode queries by the prefixed id and writes a bare-id snapshot without self", async () => {
    const { deps } = makeDeps([]);
    const queries: Array<{ id: string; namespace: string | undefined }> = [];
    const written: Record<string, unknown>[] = [];
    deps.r2.queryByVectorId = async (_index, id, _topK, namespace) => {
      queries.push({ id, namespace });
      return [
        { id: `${namespace}:rd_r`, score: 1 },
        { id: `${namespace}:rd_neighbour`, score: 0.6 },
      ];
    };
    deps.r2.putManifest = async (_keyPrefix, body) => {
      written.push(body as Record<string, unknown>);
    };

    const tenantId = "usr_11111111-1111-4111-8111-111111111111";
    const code = await corpusBackfillSimilarityCommand.run(
      ["--tenant", tenantId, "--execute"],
      deps,
    );

    expect(code).toBe(0);
    expect(queries).toEqual([{ id: `${tenantId}:rd_r`, namespace: tenantId }]);
    expect(written[0]?.similarity).toEqual({
      count: 1,
      max: 0.6,
      mean: 0.6,
      computed_at: "2026-08-22T12:00:00.000Z",
    });
  });

  it("--execute writes the manifest and flushes the index", async () => {
    const { deps, calls } = makeDeps([{ id: "rd_r", score: 1 }, { id: "rd_o", score: 0.5 }]);
    const code = await corpusBackfillSimilarityCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.puts).toEqual(["readings/rd_r"]);
    expect(calls.indexWrites).toBe(1);
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps([]);
    await expect(corpusBackfillSimilarityCommand.run(["--execute"], deps)).rejects.toThrow(
      /--tenant is required/,
    );
    expect(calls.puts).toHaveLength(0);
  });

  it("a missing vector makes an execute run incomplete (exit 1)", async () => {
    const { deps, calls } = makeDeps(null);
    const code = await corpusBackfillSimilarityCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(1);
    expect(calls.puts).toHaveLength(0);
  });
});

describe("ops corpus backfill-vectors", () => {
  const READY_MANIFEST = {
    id: "rd_v", url: "https://a.example/v", url_hash: "a".repeat(64), status: "ready",
    title: "A title", tldr: "A stored TL;DR.", tags: ["ai"],
    content_type: "text/html", content_status: "captured",
    content_bytes: 42, content_sha256: "b".repeat(64),
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
  };

  const MARKER = {
    version: 2 as const,
    last_run_at: "2026-08-22T12:00:00.000Z",
    list_ids: ["rd_v"],
  };

  function makeDeps(marker: unknown = MARKER) {
    const { io: cio, lines } = io();
    const calls = {
      embeds: 0,
      upserts: 0,
      writersMade: 0,
      markerWrites: [] as unknown[],
    };
    const deps: CorpusBackfillVectorsDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [
          {
            id: "rd_v", url: "https://a.example/v", status: "ready",
            key_prefix: "readings/rd_v", created_at: "2026-08-01T00:00:00.000Z",
          },
        ],
        vectorExists: async () => false,
        readManifest: async () => READY_MANIFEST,
        readRefreshState: async () => marker,
        writeRefreshState: async (state) => {
          calls.markerWrites.push(state);
        },
      },
      makeWriters: async () => {
        calls.writersMade++;
        return {
          embedMany: async (inputs) => {
            calls.embeds++;
            return { embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0)) };
          },
          upsert: async () => {
            calls.upserts++;
          },
        };
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode resolves eligibility but makes no embedding request or write", async () => {
    const { deps, lines, calls } = makeDeps();
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.writersMade).toBe(0);
    expect(calls.embeds).toBe(0);
    expect(calls.upserts).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Eligible missing vectors: 1");
    expect(text).toContain("no OpenAI request or write was made");
  });

  it("--execute resolves writers up front, embeds, and upserts", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.writersMade).toBe(1);
    expect(calls.embeds).toBe(1);
    expect(calls.upserts).toBe(1);
  });

  it("tenant mode probes and upserts the ADR-0002 prefixed id with its audit stamp", async () => {
    const { deps } = makeDeps();
    const probes: string[] = [];
    const upserts: Array<{ id: string; metadata?: Record<string, unknown> }[]> = [];
    deps.r2.vectorExists = async (_index, id) => {
      probes.push(id);
      return false;
    };
    deps.makeWriters = async () => ({
      embedMany: async (inputs) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0)),
      }),
      upsert: async (vectors) => {
        upserts.push(vectors);
      },
    });

    const tenantId = "usr_11111111-1111-4111-8111-111111111111";
    const code = await corpusBackfillVectorsCommand.run(
      ["--tenant", tenantId, "--execute"],
      deps,
    );

    expect(code).toBe(0);
    expect(probes).toEqual([`${tenantId}:rd_v`, `${tenantId}:rd_v`]);
    expect(upserts.map((batch) => batch.map((vector) => vector.id))).toEqual([
      [`${tenantId}:rd_v`],
    ]);
    expect(upserts[0]?.[0]?.metadata?.tenant_id).toBe(tenantId);
  });

  // A restored vector moves neighbourhoods without moving any timestamp or
  // ETag a tier-1 incremental scope can read, so the marker has to say so
  // itself rather than rely on the operator remembering --full.
  it("invalidates the tier-1 run marker before it upserts anything", async () => {
    const { deps, calls, lines } = makeDeps();
    const order: string[] = [];
    const stampedFirst = { ...deps };
    stampedFirst.r2 = {
      ...deps.r2,
      writeRefreshState: async (state) => {
        order.push("marker");
        calls.markerWrites.push(state);
      },
    };
    stampedFirst.makeWriters = async () => ({
      embedMany: async (inputs) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0)),
      }),
      upsert: async () => {
        order.push("upsert");
      },
    });
    const code = await corpusBackfillVectorsCommand.run(
      ["--tenant", "global", "--execute"],
      stampedFirst,
    );
    expect(code).toBe(0);
    expect(calls.markerWrites).toEqual([
      { ...MARKER, invalidated_by: "corpus backfill-vectors" },
    ]);
    // Crash-safety: a process killed after the upsert and before a trailing
    // stamp would leave restored vectors no later pass can find.
    expect(order).toEqual(["marker", "upsert"]);
    expect(lines.join("\n")).toContain("Run marker invalidated");
  });

  it("leaves the run marker alone in plan mode", async () => {
    const { deps, calls } = makeDeps();
    await corpusBackfillVectorsCommand.run(["--tenant", "global"], deps);
    expect(calls.markerWrites).toEqual([]);
  });

  it("writes no marker when there is nothing usable to invalidate", async () => {
    for (const stored of [null, { version: 9 }]) {
      const { deps, calls, lines } = makeDeps(stored);
      const code = await corpusBackfillVectorsCommand.run(
        ["--tenant", "global", "--execute"],
        deps,
      );
      expect(code).toBe(0);
      expect(calls.markerWrites).toEqual([]);
      expect(lines.join("\n")).toContain("the next refresh pass already sweeps");
    }
  });

  // Nothing later in the run could put this right, so the run stops before it
  // spends anything rather than leaving a stale scope behind.
  it("stops before embedding when the marker cannot be invalidated", async () => {
    const { deps, calls, lines } = makeDeps();
    deps.r2.writeRefreshState = async () => {
      throw new Error("no write");
    };
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(1);
    expect(calls.embeds).toBe(0);
    expect(calls.upserts).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("could not invalidate the tier-1 run marker: no write");
    expect(text).toContain("Nothing was embedded or upserted");
  });

  it("fails closed without --tenant", async () => {
    const { deps } = makeDeps();
    await expect(corpusBackfillVectorsCommand.run(["--execute"], deps)).rejects.toThrow(
      /--tenant is required/,
    );
  });

  it("rejects --local because Vectorize has no local store", async () => {
    const { deps } = makeDeps();
    await expect(corpusBackfillVectorsCommand.run(["--tenant", "global", "--local"], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops corpus normalize-tags", () => {
  const TAGGED = {
    id: "rd_t", url: "https://a.example/x", status: "ready",
    created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_t",
    tags: ["developer tools"],
  } as ListItem;

  function makeDeps() {
    const { io: cio, lines } = io();
    const calls = { puts: [] as unknown[], indexWrites: 0 };
    const deps: CorpusNormalizeTagsDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [TAGGED],
        readManifest: async () => ({ id: "rd_t", tags: ["developer tools"] }),
        putManifest: async (_kp, body) => {
          calls.puts.push(body);
        },
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode prints rewrites without writing", async () => {
    const { deps, lines, calls } = makeDeps();
    const code = await corpusNormalizeTagsCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(lines.join("\n")).toContain("developer-tools");
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps();
    await expect(corpusNormalizeTagsCommand.run(["--execute"], deps)).rejects.toThrow(
      /--tenant is required/,
    );
    expect(calls.puts).toHaveLength(0);
  });

  it("--execute writes manifests and the index", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusNormalizeTagsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.puts).toEqual([{ id: "rd_t", tags: ["developer-tools"] }]);
    expect(calls.indexWrites).toBe(1);
  });
});

describe("ops corpus rebuild-list", () => {
  function makeDeps() {
    const { io: cio, lines } = io();
    const calls = { indexWrites: 0 };
    const deps: CorpusRebuildListDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [],
        readManifest: async () => null,
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
    };
    return { deps, lines, calls };
  }

  it("plan mode does not write", async () => {
    const { deps, calls } = makeDeps();
    expect(await corpusRebuildListCommand.run(["--tenant", "global"], deps)).toBe(0);
    expect(calls.indexWrites).toBe(0);
  });

  it("fails closed without --tenant", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      corpusRebuildListCommand.run(["--execute", "--sole-writer"], deps),
    ).rejects.toThrow(/--tenant is required/);
    expect(calls.indexWrites).toBe(0);
  });

  it("--execute without --sole-writer refuses with exit 2", async () => {
    const { deps, calls, lines } = makeDeps();
    expect(await corpusRebuildListCommand.run(["--tenant", "global", "--execute"], deps)).toBe(2);
    expect(calls.indexWrites).toBe(0);
    expect(lines.join("\n")).toContain("REFUSED");
  });

  it("--execute --sole-writer writes the rebuilt index", async () => {
    const { deps, calls } = makeDeps();
    expect(await corpusRebuildListCommand.run(["--tenant", "global", "--execute", "--sole-writer"], deps)).toBe(0);
    expect(calls.indexWrites).toBe(1);
  });
});

describe("ops corpus ingest", () => {
  function makeDeps() {
    const { io: cio, lines } = io();
    const calls = {
      dirReads: 0, sidecarLoads: 0, configResolves: 0,
      ownershipPlans: 0, executes: 0, sidecarClears: 0,
    };
    const deps: CorpusIngestDeps = {
      io: cio,
      readMarkdownDir: async () => {
        calls.dirReads++;
        return [{
          filePath: "/md/a.md", fileName: "a.md", bytes: 50,
          markdown: "**Source:** https://a.example/x\n\nbody", sourceUrl: "https://a.example/x",
        }];
      },
      loadSidecar: async () => {
        calls.sidecarLoads++;
        return null;
      },
      clearSidecar: async () => {
        calls.sidecarClears++;
      },
      resolveConfig: () => {
        calls.configResolves++;
        return { fake: true } as never;
      },
      planOwnership: async (eligible) => {
        calls.ownershipPlans++;
        return {
          dispositions: eligible.map((a) => ({
            kind: "ingest-new" as const, url: a.sourceUrl ?? null, id: "rd_new", article: a,
          })) as never,
        };
      },
      executeBatch: async () => {
        calls.executes++;
        return { report: [{ status: "ready" }] as never, dropped: [], resumed: false, batchId: "b1", dispositions: [] };
      },
    };
    return { deps, lines, calls };
  }

  it("--execute without --sole-writer refuses before touching the directory or sidecar", async () => {
    const { deps, calls, lines } = makeDeps();
    const code = await corpusIngestCommand.run(["--tenant", "global", "--dir", "/md", "--execute"], deps);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("REFUSED");
    expect(calls.dirReads).toBe(0);
    expect(calls.sidecarLoads).toBe(0);
    expect(calls.executes).toBe(0);
  });

  it("plan mode runs the ownership check but never submits", async () => {
    const { deps, calls, lines } = makeDeps();
    const code = await corpusIngestCommand.run(["--tenant", "global", "--dir", "/md"], deps);
    expect(code).toBe(0);
    expect(calls.ownershipPlans).toBe(1);
    expect(calls.executes).toBe(0);
    expect(lines.join("\n")).toContain("would submit 1 reading(s)");
  });

  it("plan mode degrades gracefully without credentials", async () => {
    const { deps, calls, lines } = makeDeps();
    deps.resolveConfig = () => {
      throw new Error("missing batch config: CORPUS_R2_ACCOUNT_ID");
    };
    const code = await corpusIngestCommand.run(["--tenant", "global", "--dir", "/md"], deps);
    expect(code).toBe(0);
    expect(calls.ownershipPlans).toBe(0);
    expect(calls.executes).toBe(0);
    expect(lines.join("\n")).toContain("ownership check skipped");
  });

  it("--execute --sole-writer runs the batch and clears the sidecar", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusIngestCommand.run(["--tenant", "global", "--dir", "/md", "--execute", "--sole-writer"], deps);
    expect(code).toBe(0);
    expect(calls.executes).toBe(1);
    expect(calls.sidecarClears).toBe(1);
  });

  it("fails closed without --tenant", async () => {
    const { deps } = makeDeps();
    await expect(
      corpusIngestCommand.run(["--dir", "/md", "--execute", "--sole-writer"], deps),
    ).rejects.toThrow(/--tenant is required/);
  });

  it("refuses to resume a sidecar under a different tenant", async () => {
    const { deps, calls, lines } = makeDeps();
    deps.loadSidecar = async () =>
      ({ batchId: "b1", targets: [], provider: "openai", tenant: "usr_11111111-1111-4111-8111-111111111111" }) as never;
    const code = await corpusIngestCommand.run(
      ["--tenant", "global", "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.executes).toBe(0);
    expect(lines.join("\n")).toContain("belongs to tenant 'usr_11111111-1111-4111-8111-111111111111'");
  });

  it("resumes a legacy sidecar (no tenant field) under the global selector", async () => {
    const { deps, calls } = makeDeps();
    deps.loadSidecar = async () =>
      ({ batchId: "b1", targets: [], provider: "openai" }) as never;
    const code = await corpusIngestCommand.run(
      ["--tenant", "global", "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.executes).toBe(1);
  });

  it("rejects a malformed --limit", async () => {
    const { deps } = makeDeps();
    await expect(corpusIngestCommand.run(["--tenant", "global", "--dir", "/md", "--limit", "zero"], deps)).rejects.toThrow(UsageError);
  });
});
