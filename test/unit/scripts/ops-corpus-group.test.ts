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
  corpusBackfillSourceDateCommand,
  type CorpusBackfillSourceDateDeps,
  type CorpusBackfillSourceDateR2,
} from "../../../scripts/ops-lib/commands/corpus-backfill-source-date";
import { classifyStoredHtml } from "../../../scripts/corpus-lib/backfill-source-date";
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

  it.each([
    "usr_11111111-1111-4111-8111-111111111111",
    "usr_22222222-2222-4222-8222-222222222222",
    "global",
  ])("ready drop under %s preserves the other tenant and legacy copies", async (selected) => {
    const selectors = [
      "usr_11111111-1111-4111-8111-111111111111",
      "usr_22222222-2222-4222-8222-222222222222",
      "global",
    ];
    const root = (selector: string) => selector === "global" ? "" : `u/${selector}/`;
    const vectorId = (selector: string) => selector === "global" ? "rd_shared" : `${selector}:rd_shared`;
    const item: ListItem = {
      ...FAILED_ITEM, id: "rd_shared", key_prefix: "readings/rd_shared", status: "ready",
    };
    const keys = ["readings/rd_shared/manifest.json", "readings/rd_shared/extracted.md", "index/by-id/rd_shared"];
    const lists = new Map(selectors.map((s) => [root(s), [structuredClone(item)]]));
    const objects = new Map(selectors.flatMap((s) => keys.map((key) => [root(s) + key, `${s}:${key}`] as const)));
    const vectors = new Map(selectors.map((s) => [vectorId(s), { namespace: s, title: `${s} copy` }]));
    const before = structuredClone({ lists, objects, vectors });
    const { io: cio, lines } = io();
    const deps: CorpusDropDeps = {
      io: cio,
      r2: {
        readListIndex: async (d) => structuredClone(lists.get(d.keyRoot)!),
        keysForReading: async () => keys,
        deleteObject: async (key, d) => objects.delete(d.keyRoot + key) ? "deleted" : "absent",
        deleteVector: async (_index, id) => { vectors.delete(id); return "deleted"; },
        writeListIndex: async (items, d) => { lists.set(d.keyRoot, structuredClone(items)); },
      },
    };
    const args = ["--tenant", selected, item.id, "--allow-ready", "--bucket", "reading-lite-staging", "--vectorize", "staging-index"];

    expect(await corpusDropCommand.run(args, deps)).toBe(0);
    expect({ lists, objects, vectors }).toEqual(before);
    expect(lines.join("\n")).toContain(`would delete vector  staging-index/${vectorId(selected)}`);

    expect(await corpusDropCommand.run([...args, "--execute"], deps)).toBe(0);
    expect(lists.get(root(selected))).toEqual([]);
    expect(vectors.has(vectorId(selected))).toBe(false);
    for (const key of keys) expect(objects.has(root(selected) + key)).toBe(false);
    for (const other of selectors.filter((s) => s !== selected)) {
      expect(lists.get(root(other))).toEqual(before.lists.get(root(other)));
      expect(vectors.get(vectorId(other))).toEqual(before.vectors.get(vectorId(other)));
      for (const key of keys) expect(objects.get(root(other) + key)).toBe(before.objects.get(root(other) + key));
    }
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

  it("sweeps only the selected populated tenant when ids overlap", async () => {
    const tenantA = "usr_11111111-1111-4111-8111-111111111111";
    const tenantB = "usr_22222222-2222-4222-8222-222222222222";
    const rootA = `u/${tenantA}/`;
    const rootB = `u/${tenantB}/`;
    const lists = new Map([[rootA, structuredClone(DUP_ITEMS)], [rootB, structuredClone(DUP_ITEMS)]]);
    const objects = new Map([
      [rootA, new Set(["readings/rd_dup/manifest.json"])],
      [rootB, new Set(["readings/rd_dup/manifest.json"])],
    ]);
    const vectors = new Set([`${tenantA}:rd_dup`, `${tenantB}:rd_dup`]);
    const { io: cio } = io();
    const deps: CorpusSweepDeps = {
      io: cio,
      r2: {
        readListIndex: async (d) => lists.get(d.keyRoot)!,
        readManifest: async () => null,
        keysForReading: async (_id, prefix) => [`${prefix}/manifest.json`],
        deleteObject: async (key, d) => {
          objects.get(d.keyRoot)!.delete(key);
          return "deleted";
        },
        deleteVector: async (_index, id) => {
          vectors.delete(id);
          return "deleted";
        },
        vectorExists: async (_index, id) => vectors.has(id),
        writeListIndex: async (items, d) => {
          lists.set(d.keyRoot, items as typeof DUP_ITEMS);
        },
      },
    };
    expect(await corpusSweepCommand.run(["--tenant", tenantA, "--execute"], deps)).toBe(0);
    expect(lists.get(rootA)).toHaveLength(1);
    expect(objects.get(rootA)!.has("readings/rd_dup/manifest.json")).toBe(false);
    expect(vectors.has(`${tenantA}:rd_dup`)).toBe(false);
    expect(lists.get(rootB)).toHaveLength(2);
    expect(objects.get(rootB)!.has("readings/rd_dup/manifest.json")).toBe(true);
    expect(vectors.has(`${tenantB}:rd_dup`)).toBe(true);
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

  it("deletes an overlapping orphan only under the selected tenant root", async () => {
    const tenantA = "usr_11111111-1111-4111-8111-111111111111";
    const tenantB = "usr_22222222-2222-4222-8222-222222222222";
    const rootA = `u/${tenantA}/`;
    const rootB = `u/${tenantB}/`;
    const lists = new Map([
      [rootA, structuredClone(LIST)],
      [rootB, structuredClone(LIST)],
    ]);
    const objects = new Map([
      [rootA, new Set(["readings/rd_orphan/manifest.json", "index/by-id/rd_orphan"])],
      [rootB, new Set(["readings/rd_orphan/manifest.json", "index/by-id/rd_orphan"])],
    ]);
    const { io: cio } = io();
    const deps: CorpusDeleteOrphansDeps = {
      io: cio,
      readFile: async () => "unused",
      r2: {
        readObject: async (_key, d) => JSON.stringify(lists.get(d.keyRoot)),
        keysForReading: async (id, prefix) => [`${prefix}/manifest.json`, `index/by-id/${id}`],
        deleteObject: async (key, d) => {
          objects.get(d.keyRoot)!.delete(key);
          return "deleted";
        },
        writeListIndex: async (items, d) => {
          lists.set(d.keyRoot, { items });
        },
      },
    };
    expect(await corpusDeleteOrphansCommand.run(
      ["--tenant", tenantA, "--ids", "rd_orphan", "--execute"], deps,
    )).toBe(0);
    expect(lists.get(rootA)!.items.map((item) => item.id)).toEqual(["rd_ready"]);
    expect(objects.get(rootA)!.size).toBe(0);
    expect(lists.get(rootB)!.items.map((item) => item.id)).toEqual(["rd_ready", "rd_orphan"]);
    expect(objects.get(rootB)!.size).toBe(2);
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

  const RUN_AT = "2026-08-22T12:00:00.000Z";

  function makeDeps(marker: unknown = MARKER) {
    const { io: cio, lines } = io();
    const calls = {
      embeds: 0,
      upserts: 0,
      writersMade: 0,
      markerWrites: [] as unknown[],
      // `live:{readingId}:{upserts at the time}` — issue #195 S3. The suffix is
      // what makes "before the upsert, not after" assertable.
      ledgered: [] as string[],
      ledgersMade: [] as Array<{ tenant: string; bucket: string; execute: boolean }>,
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
        readRefreshState: async () => {
          if (marker instanceof Error) throw marker;
          return marker;
        },
        writeRefreshState: async (state) => {
          calls.markerWrites.push(state);
        },
      },
      now: () => Date.parse(RUN_AT),
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
      makeLedger: (opts) => {
        calls.ledgersMade.push({
          tenant: opts.tenant.kind === "tenant" ? opts.tenant.tenantId : "global",
          bucket: opts.bucket,
          execute: opts.execute,
        });
        return {
          markLive: async (ids) => {
            for (const id of ids) calls.ledgered.push(`live:${id}:${calls.upserts}`);
          },
          markDeleteSubmitted: async () => {},
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
    // The vector-ledger row is written BEFORE the upsert it describes (the `:0`
    // suffix is the upsert count at the time). A row for an upsert that then
    // fails costs one no-op deleteByIds; an upsert with no row is a vector
    // nothing can address once the reading's R2 objects are gone.
    expect(calls.ledgered).toEqual(["live:rd_v:0"]);
  });

  it("resolves the ledger for the run's own tenant, bucket and mode", async () => {
    const { deps, calls } = makeDeps();
    await corpusBackfillVectorsCommand.run(["--tenant", "global"], deps);
    // Plan mode still resolves it — and asks for the no-op by passing
    // execute:false — so an unrecognised --bucket is refused before any write.
    expect(calls.ledgersMade).toEqual([
      { tenant: "global", bucket: "reading-lite", execute: false },
    ]);
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
  it("stamps the run marker either side of the upsert, with a value of its own", async () => {
    const { deps, calls, lines } = makeDeps();
    const order: string[] = [];
    const traced = { ...deps };
    traced.r2 = {
      ...deps.r2,
      writeRefreshState: async (state) => {
        order.push("marker");
        calls.markerWrites.push(state);
      },
    };
    traced.makeWriters = async () => ({
      embedMany: async (inputs) => ({
        embeddings: inputs.map(() => Array.from({ length: 1536 }, () => 0)),
      }),
      upsert: async () => {
        order.push("upsert");
      },
    });
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], traced);
    expect(code).toBe(0);
    expect(calls.markerWrites).toEqual([
      { ...MARKER, invalidated_by: `corpus backfill-vectors started ${RUN_AT}` },
      { ...MARKER, invalidated_by: `corpus backfill-vectors finished ${RUN_AT}` },
    ]);
    // The opening stamp is crash-safety: a process killed after the upsert and
    // before any stamp would leave restored vectors no later pass can find. The
    // closing one covers a refresh pass that started between them, swept
    // without these vectors, and would otherwise clear the opening stamp.
    expect(order).toEqual(["marker", "upsert", "marker"]);
    expect(lines.join("\n")).toContain("Run marker invalidated");
  });

  // Another run's stamp is another run's: a refresh answering it would clear it
  // and go on to miss the vectors this run is about to write.
  it("overwrites a stamp left by an earlier backfill", async () => {
    const { deps, calls } = makeDeps({ ...MARKER, invalidated_by: "corpus backfill-vectors started 2026-01-01T00:00:00.000Z" });
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.markerWrites).toHaveLength(2);
    expect((calls.markerWrites[0] as { invalidated_by: string }).invalidated_by).toBe(
      `corpus backfill-vectors started ${RUN_AT}`,
    );
  });

  // A damaged marker already makes the next refresh sweep, so it must not block
  // a repair command under a message about credentials.
  it("proceeds when the stored marker is unparseable JSON", async () => {
    const { deps, calls, lines } = makeDeps(new SyntaxError("Unexpected token }"));
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.upserts).toBe(1);
    expect(calls.markerWrites[0]).toMatchObject({
      invalidated_by: `corpus backfill-vectors started ${RUN_AT}`,
    });
    expect(lines.join("\n")).toContain("Run marker: unparseable");
  });

  it("leaves the run marker alone in plan mode", async () => {
    const { deps, calls } = makeDeps();
    await corpusBackfillVectorsCommand.run(["--tenant", "global"], deps);
    expect(calls.markerWrites).toEqual([]);
  });

  // An absent or unusable marker makes the NEXT pass sweep by itself, but a
  // pass already running read that same absent marker and would otherwise
  // advance afterwards, recording as covered a sweep these vectors missed.
  it("stamps a minimal marker when there is none to stamp", async () => {
    for (const stored of [null, { version: 9 }]) {
      const { deps, calls } = makeDeps(stored);
      const code = await corpusBackfillVectorsCommand.run(
        ["--tenant", "global", "--execute"],
        deps,
      );
      expect(code).toBe(0);
      // Epoch and an empty id list: the stamp is what forces the sweep, and
      // those are the two fields a scope would narrow on without it.
      expect(calls.markerWrites[0]).toEqual({
        version: 2,
        last_run_at: "1970-01-01T00:00:00.000Z",
        list_ids: [],
        invalidated_by: `corpus backfill-vectors started ${RUN_AT}`,
      });
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

  // The vectors are already in the index by then, so the operator is told to
  // sweep rather than to re-run.
  it("fails the run when the closing stamp cannot be written", async () => {
    const { deps, calls, lines } = makeDeps();
    let writes = 0;
    deps.r2.writeRefreshState = async () => {
      writes++;
      if (writes > 1) throw new Error("no write");
    };
    const code = await corpusBackfillVectorsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(1);
    expect(calls.upserts).toBe(1);
    expect(lines.join("\n")).toContain("refresh-neighbours --full");
  });


  it("rejects --local because Vectorize has no local store", async () => {
    const { deps } = makeDeps();
    await expect(corpusBackfillVectorsCommand.run(["--tenant", "global", "--local"], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops corpus backfill-source-date", () => {
  const NOW = Date.parse("2026-09-18T12:00:00.000Z");
  const DATED_HTML = `<!doctype html>
<html><head><title>Hello World</title>
<meta property="article:published_time" content="2024-03-15T08:00:00-05:00">
</head>
<body>
<main><article>
<h1>Hello World</h1>
<p>This is the first paragraph. It contains enough words to be picked up by readability as the main content body.</p>
<p>This is a second paragraph with more substantial body text so that the article passes the readability threshold for length.</p>
</article></main>
</body></html>`;
  const UNDATED_HTML = `<!doctype html>
<html><head><title>Hello World</title></head>
<body>
<main><article>
<h1>Hello World</h1>
<p>This is the first paragraph. It contains enough words to be picked up by readability as the main content body.</p>
<p>This is a second paragraph with more substantial body text so that the article passes the readability threshold for length.</p>
</article></main>
</body></html>`;

  const ITEM: ListItem = {
    id: "rd_r", url: "https://example.com/a", status: "ready",
    created_at: "2026-08-01T00:00:00.000Z", key_prefix: "readings/rd_r",
  };

  const BASE_MANIFEST = {
    id: "rd_r", url: "https://example.com/a", url_hash: "a".repeat(64), status: "ready",
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    content_type: "text/html", content_status: "captured",
    content_bytes: 10, content_sha256: "b".repeat(64),
    source_type: "url" as const,
    title: "Hello World",
  };

  function makeDeps(opts: {
    items?: ListItem[];
    manifest?: Record<string, unknown> | null;
    rawHtml?: string | null;
  } = {}) {
    const { io: cio, lines } = io();
    const calls = { rawReads: 0, puts: [] as Record<string, unknown>[], indexWrites: 0 };
    const deps: CorpusBackfillSourceDateDeps = {
      io: cio,
      r2: {
        readListIndex: async () => opts.items ?? [ITEM],
        readManifest: async () => opts.manifest === undefined ? { ...BASE_MANIFEST } : opts.manifest,
        readRawHtml: async () => {
          calls.rawReads++;
          return opts.rawHtml === undefined ? DATED_HTML : opts.rawHtml;
        },
        putManifest: async (_kp, body) => {
          calls.puts.push(body as Record<string, unknown>);
        },
        writeListIndex: async () => {
          calls.indexWrites++;
        },
      },
      now: () => NOW,
    };
    return { deps, lines, calls };
  }

  it("plan mode reports would-gain and writes nothing", async () => {
    const { deps, lines, calls } = makeDeps();
    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.rawReads).toBe(1);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Would gain a date: 1");
    expect(text).toContain("Already dated: 0");
    expect(text).toContain("Skipped (markdown): 0");
    expect(text).toContain("No raw HTML: 0");
    expect(text).toContain("PLAN — nothing changed");
  });

  it("skips markdown-imported readings without reading raw HTML", async () => {
    const { deps, lines, calls } = makeDeps({
      manifest: { ...BASE_MANIFEST, source_type: "markdown", content_type: "text/markdown" },
    });
    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global"], deps);
    expect(code).toBe(0);
    expect(calls.rawReads).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(lines.join("\n")).toContain("Skipped (markdown): 1");
    expect(lines.join("\n")).toContain("Would gain a date: 0");
  });

  it("skips a reading that already has source_date and does not overwrite", async () => {
    const { deps, lines, calls } = makeDeps({
      manifest: { ...BASE_MANIFEST, source_date: "2020-01-01" },
    });
    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.rawReads).toBe(0);
    expect(calls.puts).toHaveLength(0);
    expect(calls.indexWrites).toBe(0);
    expect(lines.join("\n")).toContain("Already dated: 1");
  });

  it("--execute writes only source_date when stored HTML has a date", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]?.source_date).toBe("2024-03-15");
    expect(calls.puts[0]?.title).toBe("Hello World");
    expect(calls.puts[0]?.updated_at).toBe("2026-08-01T00:00:00.000Z");
    expect(calls.indexWrites).toBe(1);
  });

  it("writes nothing when raw HTML is absent or unparseable", async () => {
    const missing = makeDeps({ rawHtml: null });
    expect(await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], missing.deps)).toBe(0);
    expect(missing.calls.puts).toHaveLength(0);
    expect(missing.calls.indexWrites).toBe(0);
    expect(missing.lines.join("\n")).toContain("No raw HTML: 1");
    expect(missing.lines.join("\n")).toContain("Would gain a date: 0");

    const junk = makeDeps({ rawHtml: UNDATED_HTML });
    expect(await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], junk.deps)).toBe(0);
    expect(junk.calls.puts).toHaveLength(0);
    expect(junk.lines.join("\n")).toContain("Unparseable: 1");
  });

  it("fills only the selected tenant when ids overlap", async () => {
    const tenant = "usr_11111111-1111-4111-8111-111111111111";
    const other = "usr_22222222-2222-4222-8222-222222222222";
    const roots = [`u/${tenant}/`, `u/${other}/`];
    const lists = new Map<string, ListItem[]>(roots.map((root) => [root, [structuredClone(ITEM)]]));
    const manifests = new Map<string, Map<string, Record<string, unknown>>>(
      roots.map((root) => [root, new Map([[ITEM.key_prefix, { ...BASE_MANIFEST }]])]),
    );
    const raw = new Map(roots.map((root) => [root, DATED_HTML]));
    const { io: cio } = io();
    const deps: CorpusBackfillSourceDateDeps = {
      io: cio,
      r2: {
        readListIndex: async (d) => lists.get(d.keyRoot)!,
        readManifest: async (prefix, d) => manifests.get(d.keyRoot)!.get(prefix) ?? null,
        readRawHtml: async (_prefix, d) => raw.get(d.keyRoot) ?? null,
        putManifest: async (prefix, body, d) => {
          manifests.get(d.keyRoot)!.set(prefix, body as typeof BASE_MANIFEST);
        },
        writeListIndex: async (items, d) => {
          lists.set(d.keyRoot, items);
        },
      },
      now: () => NOW,
    };

    expect(await corpusBackfillSourceDateCommand.run(["--tenant", tenant, "--execute"], deps)).toBe(0);
    expect(manifests.get(roots[0])!.get(ITEM.key_prefix)?.source_date).toBe("2024-03-15");
    expect(lists.get(roots[0])?.[0]?.source_date).toBe("2024-03-15");
    expect(manifests.get(roots[1])!.get(ITEM.key_prefix)?.source_date).toBeUndefined();
    expect(lists.get(roots[1])?.[0]?.source_date).toBeUndefined();
  });

  it("re-reads the live manifest before put and merges only source_date", async () => {
    const stale = {
      ...BASE_MANIFEST,
      title: "Stale title",
      tags: ["old"],
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    const live = {
      ...BASE_MANIFEST,
      title: "Ready rewrite",
      tags: ["new"],
      summary_markdown: "fresh body",
      updated_at: "2026-09-19T02:00:00.000Z",
      status: "ready",
    };
    let manifestReads = 0;
    const { io: cio, lines } = io();
    const puts: Record<string, unknown>[] = [];
    const deps: CorpusBackfillSourceDateDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [ITEM],
        readManifest: async () => {
          manifestReads++;
          return manifestReads === 1 ? { ...stale } : { ...live };
        },
        readRawHtml: async () => DATED_HTML,
        putManifest: async (_kp, body) => {
          puts.push(body as Record<string, unknown>);
        },
        writeListIndex: async () => {},
      },
      now: () => NOW,
    };

    expect(await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], deps)).toBe(0);
    expect(manifestReads).toBe(2);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      title: "Ready rewrite",
      tags: ["new"],
      summary_markdown: "fresh body",
      updated_at: "2026-09-19T02:00:00.000Z",
      source_date: "2024-03-15",
    });
    expect(puts[0]?.title).not.toBe("Stale title");
    expect(lines.join("\n")).toContain("Would gain a date: 1, written: 1");
  });

  it("refuses to write when the live re-read already has source_date", async () => {
    let manifestReads = 0;
    const { io: cio, lines } = io();
    const puts: unknown[] = [];
    const deps: CorpusBackfillSourceDateDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [ITEM],
        readManifest: async () => {
          manifestReads++;
          return manifestReads === 1
            ? { ...BASE_MANIFEST }
            : { ...BASE_MANIFEST, source_date: "2020-01-01", title: "Concurrent ready" };
        },
        readRawHtml: async () => DATED_HTML,
        putManifest: async (_kp, body) => {
          puts.push(body);
        },
        writeListIndex: async () => {},
      },
      now: () => NOW,
    };

    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(1);
    expect(puts).toHaveLength(0);
    expect(lines.join("\n")).toContain("source_date already present");
    expect(lines.join("\n")).toContain("run incomplete");
  });

  it("a throwing classify costs one reading and still writes later rows", async () => {
    const throwItem: ListItem = { ...ITEM, id: "rd_throw", url: "https://example.com/throw", key_prefix: "readings/rd_throw" };
    const okItem: ListItem = { ...ITEM, id: "rd_ok", url: "https://example.com/ok", key_prefix: "readings/rd_ok" };
    const { io: cio, lines } = io();
    const puts: string[] = [];
    let indexWrites = 0;
    const deps: CorpusBackfillSourceDateDeps = {
      io: cio,
      r2: {
        readListIndex: async () => [throwItem, okItem],
        readManifest: async (prefix) => ({
          ...BASE_MANIFEST,
          id: prefix.endsWith("rd_throw") ? "rd_throw" : "rd_ok",
          url: prefix.endsWith("rd_throw") ? throwItem.url : okItem.url,
        }),
        readRawHtml: async () => DATED_HTML,
        putManifest: async (prefix) => {
          puts.push(prefix);
        },
        writeListIndex: async () => {
          indexWrites++;
        },
      },
      now: () => NOW,
      classifyHtml: (input) => {
        if (input.url.includes("/throw")) throw new Error("turndown salvage failed");
        return classifyStoredHtml(input);
      },
    };

    const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(1);
    expect(puts).toEqual(["readings/rd_ok"]);
    expect(indexWrites).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("inspect/write failed for rd_throw");
    expect(text).toContain("turndown salvage failed");
    expect(text).toContain("Would gain a date: 1, written: 1");
    expect(text).toContain("run incomplete");
  });

  describe("storage backend selection", () => {
    const S3_CREDS = {
      CORPUS_R2_ACCOUNT_ID: "acct",
      CORPUS_R2_ACCESS_KEY: "AKIA",
      CORPUS_R2_SECRET_KEY: "secret",
    };

    function tracked(
      deps: CorpusBackfillSourceDateDeps,
      used: string[],
      label: string,
    ): CorpusBackfillSourceDateR2 {
      return {
        ...deps.r2,
        readListIndex: async (d) => {
          used.push(label);
          return deps.r2.readListIndex(d);
        },
      };
    }

    it("uses wrangler and says so when no credentials are present", async () => {
      const { deps, lines } = makeDeps();
      const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global"], deps);
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/^Storage: wrangler/m);
    });

    it("auto-selects the direct path when CORPUS_R2_* keys are present", async () => {
      const { deps, lines } = makeDeps();
      const used: string[] = [];
      const direct = tracked(deps, used, "direct");
      const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global"], {
        ...deps,
        r2: tracked(deps, used, "wrangler"),
        directR2: () => direct,
        storageVars: () => S3_CREDS,
      });
      expect(code).toBe(0);
      expect(used).toEqual(["direct"]);
      expect(lines.join("\n")).toMatch(/^Storage: direct \(S3\/REST\) — CORPUS_R2_\* keys/m);
      expect(lines.join("\n")).toContain("Account: acct");
    });

    it("--via wrangler forces the fallback even with S3 keys present", async () => {
      const { deps, lines } = makeDeps();
      const used: string[] = [];
      const direct = tracked(deps, used, "direct");
      const code = await corpusBackfillSourceDateCommand.run(
        ["--tenant", "global", "--via", "wrangler"],
        { ...deps, r2: tracked(deps, used, "wrangler"), directR2: () => direct, storageVars: () => S3_CREDS },
      );
      expect(code).toBe(0);
      expect(used).toEqual(["wrangler"]);
      expect(lines.join("\n")).toMatch(/^Storage: wrangler — --via wrangler/m);
    });

    it("reports the fallback it actually used when no direct client exists", async () => {
      const { deps, lines } = makeDeps();
      const code = await corpusBackfillSourceDateCommand.run(["--tenant", "global"], {
        ...deps,
        storageVars: () => S3_CREDS,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/^Storage: wrangler/m);
      expect(lines.join("\n")).not.toMatch(/^Storage: direct/m);
    });

    it("rejects an unknown --via value as usage", async () => {
      const { deps } = makeDeps();
      await expect(
        corpusBackfillSourceDateCommand.run(["--tenant", "global", "--via", "s3"], deps),
      ).rejects.toThrow(/--via "s3" is not one of/);
    });

    it("rejects --via direct with --local", async () => {
      const { deps } = makeDeps();
      await expect(
        corpusBackfillSourceDateCommand.run(
          ["--tenant", "global", "--via", "direct", "--local"],
          deps,
        ),
      ).rejects.toThrow(/--via direct cannot be combined with --local/);
    });

    it("documents --via in help", () => {
      expect(corpusBackfillSourceDateCommand.helpText).toContain("--via <path>");
      expect(corpusBackfillSourceDateCommand.helpText).toContain("S3 keys");
    });
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


  it("--execute writes manifests and the index", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusNormalizeTagsCommand.run(["--tenant", "global", "--execute"], deps);
    expect(code).toBe(0);
    expect(calls.puts).toEqual([{ id: "rd_t", tags: ["developer-tools"] }]);
    expect(calls.indexWrites).toBe(1);
  });

  it("normalizes only the selected populated tenant when ids overlap", async () => {
    const tenant = "usr_11111111-1111-4111-8111-111111111111";
    const other = "usr_22222222-2222-4222-8222-222222222222";
    const roots = [`u/${tenant}/`, `u/${other}/`];
    const lists = new Map<string, ListItem[]>(roots.map((root) => [root, [structuredClone(TAGGED)]]));
    const manifests = new Map<string, Map<string, { id: string; tags: string[] }>>(roots.map((root) => [root, new Map([[TAGGED.key_prefix, { id: "rd_t", tags: ["developer tools"] }]])]));
    const { io: cio } = io();
    const deps: CorpusNormalizeTagsDeps = {
      io: cio,
      r2: {
        readListIndex: async (d) => lists.get(d.keyRoot)!,
        readManifest: async (prefix, d) => manifests.get(d.keyRoot)!.get(prefix) ?? null,
        putManifest: async (prefix, body, d) => { manifests.get(d.keyRoot)!.set(prefix, body as { id: string; tags: string[] }); },
        writeListIndex: async (items, d) => { lists.set(d.keyRoot, items); },
      },
    };
    expect(await corpusNormalizeTagsCommand.run(["--tenant", tenant, "--execute"], deps)).toBe(0);
    expect(manifests.get(roots[0])!.get(TAGGED.key_prefix)?.tags).toEqual(["developer-tools"]);
    expect((lists.get(roots[0])?.[0] as { tags?: string[] } | undefined)?.tags).toEqual(["developer-tools"]);
    expect(manifests.get(roots[1])!.get(TAGGED.key_prefix)?.tags).toEqual(["developer tools"]);
    expect((lists.get(roots[1])?.[0] as { tags?: string[] } | undefined)?.tags).toEqual(["developer tools"]);
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

  it("rebuilds only the selected populated tenant list and manifest projection", async () => {
    const tenant = "usr_11111111-1111-4111-8111-111111111111";
    const other = "usr_22222222-2222-4222-8222-222222222222";
    const roots = [`u/${tenant}/`, `u/${other}/`];
    const source = { id: "rd_a", key_prefix: "readings/2026/01/01T000000Z-rd_a", url: "https://example.com/a", status: "ready" as const, created_at: "2026-01-01T00:00:00.000Z" };
    const manifest = { ...source, url_hash: "a".repeat(64), title: "A", tldr: "Summary", content_type: "text/html", content_status: "captured", content_bytes: 1, content_sha256: "b".repeat(64), updated_at: "2026-01-01T00:00:00.000Z", keywords: ["selected"] };
    const lists = new Map<string, ListItem[]>(roots.map((root) => [root, [structuredClone(source)]]));
    const { io: cio } = io();
    const deps: CorpusRebuildListDeps = {
      io: cio,
      r2: {
        readListIndex: async (d) => lists.get(d.keyRoot)!,
        readManifest: async (_prefix, d) => d.keyRoot === roots[0] ? manifest : { ...manifest, keywords: ["other"] },
        writeListIndex: async (items, d) => { lists.set(d.keyRoot, items as ListItem[]); },
      },
    };
    expect(await corpusRebuildListCommand.run(
      ["--tenant", tenant, "--execute", "--sole-writer"], deps,
    )).toBe(0);
    expect(lists.get(roots[0])?.[0]).toMatchObject({ id: "rd_a", keywords: ["selected"] });
    expect(lists.get(roots[1])?.[0]).not.toHaveProperty("keywords");
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
      resolveConfig: (flags) => {
        calls.configResolves++;
        // A minimal but SHAPE-HONEST config: `tenant` and `r2.bucket` are what
        // the vector-ledger availability check reads (issue #195 S3), and a
        // double that omitted them would make the command look broken for a
        // reason the test is not about.
        return { tenant: flags.tenant, r2: { bucket: "reading-lite" } } as never;
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

  it("refuses a real tenant on a bucket with no control plane, before submitting", async () => {
    // A vector written without a ledger row is unaddressable once the reading's
    // R2 objects are gone (issue #195 S3), so a tenant whose ids have nowhere
    // to be recorded must stop the run — and stop it before the batch, not at
    // the first upsert half way through a paid, resumable pass.
    const { deps, calls } = makeDeps();
    deps.resolveConfig = (flags) => {
      calls.configResolves++;
      return { tenant: flags.tenant, r2: { bucket: "some-scratch-bucket" } } as never;
    };
    const code = await corpusIngestCommand.run(
      ["--tenant", "usr_11111111-1111-4111-8111-111111111111", "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(2);
    expect(calls.executes).toBe(0);
  });

  it("still allows --tenant global on any bucket", async () => {
    // The pre-tenant corpus has no tenant id to key ledger rows by, and no
    // account wipe addresses it, so there is nothing to refuse. Run in execute
    // mode: plan mode swallows a ledger refusal and still exits 0, so only a
    // submitted batch proves the guard let global through.
    const { deps, calls } = makeDeps();
    deps.resolveConfig = (flags) => {
      calls.configResolves++;
      return { tenant: flags.tenant, r2: { bucket: "some-scratch-bucket" } } as never;
    };
    const code = await corpusIngestCommand.run(
      ["--tenant", "global", "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.executes).toBe(1);
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
