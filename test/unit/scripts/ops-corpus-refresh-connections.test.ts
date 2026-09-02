import { describe, expect, it, vi } from "vitest";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
import type { R2InventoryClient } from "../../../scripts/lib/cf-clients";
import {
  corpusRefreshConnectionsCommand,
  parseProductionWorkerVars,
  storageFromClient,
  type CorpusRefreshConnectionsDeps,
  type RefreshConnectionsStorage,
} from "../../../scripts/ops-lib/commands/corpus-refresh-connections";

const AT = "2026-08-31T12:00:00.000Z";
const JUDGED_AT = "2026-08-31T12:01:00.000Z";

function listRow(id: string) {
  return {
    id,
    key_prefix: `readings/2026/${id}`,
    url: `https://example.com/${id}`,
    status: "ready" as const,
    title: id,
    tldr: `Summary ${id}`,
    tags: ["x"],
    novelty_verdict: "novel" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: id,
    tldr: `Summary ${id}`,
    tags: ["x"],
    keywords: ["one", "two", "three"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: `Stored summary ${id}.`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    future_field: { keep: id },
    ...overrides,
  };
}

function report(ids = ["rd_a", "rd_c"]) {
  return {
    version: 1,
    generated_at: AT,
    tenant: "global",
    floor: SIMILARITY_FLOOR,
    readings: ids.map((id) => ({
      id,
      key_prefix: `readings/2026/${id}`,
      url: `https://example.com/${id}`,
      reasons: ["new_neighbour"],
      novelty_verdict: "novel",
      connections: [],
      current_neighbours: [
        {
          id: "rd_b",
          score: 0.9,
          title: "rd_b",
          tldr: "Summary rd_b",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    })),
  };
}

function harness(opts: { cas?: boolean; failListOnce?: boolean } = {}) {
  let items = [listRow("rd_a"), listRow("rd_b"), listRow("rd_c")];
  const manifests = new Map<
    string,
    { manifest: Record<string, unknown>; etag: string }
  >([
    ["readings/2026/rd_a", { manifest: manifest("rd_a"), etag: "e-a" }],
    ["readings/2026/rd_b", { manifest: manifest("rd_b"), etag: "e-b" }],
    ["readings/2026/rd_c", { manifest: manifest("rd_c"), etag: "e-c" }],
  ]);
  const writes: Array<{ keyPrefix: string; manifest: Record<string, unknown>; etag: string }> = [];
  const listWrites: typeof items[] = [];
  let failList = opts.failListOnce === true;
  const storage: RefreshConnectionsStorage = {
    readListIndex: async () => items,
    readManifest: async (keyPrefix) => manifests.get(keyPrefix) ?? null,
    putManifestIfMatch: async (keyPrefix, next, etag) => {
      writes.push({ keyPrefix, manifest: next, etag });
      if (opts.cas === false) return false;
      manifests.set(keyPrefix, { manifest: next, etag: `${etag}-next` });
      return true;
    },
    writeListIndex: async (next) => {
      if (failList) {
        failList = false;
        throw new Error("list unavailable");
      }
      items = next as typeof items;
      listWrites.push(items);
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const judge = vi.fn(async () => ({
    judgement: {
      novelty_verdict: "familiar" as const,
      connections: [{ id: "rd_b", reason: "related" }],
    },
    usage: {
      provider: "openai" as const,
      model: "gpt-5.6-terra",
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
    },
  }));
  const readReport = vi.fn(async () => JSON.stringify(report()));
  const createStorage = vi.fn(async () => storage);
  const deps: CorpusRefreshConnectionsDeps = {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    readReport,
    createStorage,
    loadProvider: async () => ({
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "high",
      estimate: () => ({ inputTokens: 500, outputTokens: 256, costUsd: 0.005 }),
      judge,
    }),
    now: () => Date.parse(JUDGED_AT),
  };
  return {
    deps,
    out,
    err,
    judge,
    readReport,
    createStorage,
    writes,
    listWrites,
    manifests,
    items: () => items,
  };
}

/** A fake clock that advances a fixed step on every read. */
function fakeClock(stepMs: number, startMs = Date.parse(JUDGED_AT)) {
  let value = startMs - stepMs;
  return () => {
    value += stepMs;
    return value;
  };
}

describe("ops corpus refresh-connections", () => {
  it("prints a Timing block for a plan pass with no provider phase", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", "global"], {
        ...h.deps,
        now: fakeClock(10),
      }),
    ).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Timing:");
    expect(text).toMatch(/list read\s+1 call\s+0\.010s/);
    // Three reads, overlapped: the phase total is the sum of the call
    // durations, which under concurrency is longer than the wall time they
    // actually took.
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.050s/);
    expect(text).not.toMatch(/^ {2}provider\s+\d+ call/m);
    expect(text).not.toContain("manifest write");
  });

  it("still prints the Timing block when the pass throws on a stale report", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("readings/2026/rd_a")!.manifest.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        { ...h.deps, now: fakeClock(10) },
      ),
    ).rejects.toThrow(/target rd_a changed/);
    // The reads it already paid for are the reason this pass is worth timing.
    expect(h.out.join("\n")).toMatch(/planning reads\s+\d+ calls/);
  });

  it("separates planning reads from the execute pass and times each judgement", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        { ...h.deps, now: fakeClock(10) },
      ),
    ).toBe(0);
    const text = h.out.join("\n");
    // Three manifests read while planning; each judged target re-read once for
    // a fresh ETag before its call.
    expect(text).toMatch(/planning reads\s+3 calls\s+0\.050s/);
    expect(text).toMatch(/manifest read\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/provider\s+2 calls\s+0\.020s/);
    expect(text).toMatch(/manifest write\s+2 calls/);
    expect(text).toMatch(/list write\s+1 call/);
    expect(text).toContain("rd_a  usage input=100 output=20 reasoning=0 ms=10");
  });

  it("reads provider settings from the production Worker section", () => {
    expect(
      parseProductionWorkerVars(`
[vars]
OPENAI_SUMMARIZATION_REASONING_EFFORT = "low"

[env.production.vars]
SUMMARIZER_PROVIDER = "openai"
OPENAI_SUMMARIZATION_MODEL = "gpt-5.6-terra"
OPENAI_SUMMARIZATION_REASONING_EFFORT = "high"

[[env.production.queues.producers]]
binding = "READING_JOBS"
`),
    ).toEqual({
      SUMMARIZER_PROVIDER: "openai",
      OPENAI_SUMMARIZATION_MODEL: "gpt-5.6-terra",
      OPENAI_SUMMARIZATION_REASONING_EFFORT: "high",
    });
  });

  it("prints every planned judgement and estimated cost without provider or storage writes", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps),
    ).toBe(0);
    expect(h.out.join("\n")).toContain("rd_a  judge");
    expect(h.out.join("\n")).toContain("rd_c  judge");
    expect(h.out.join("\n")).toContain("prior=novel[(none)]");
    expect(h.out.join("\n")).toContain("candidates=rd_b@0.900");
    expect(h.out.join("\n")).toContain("Estimated synchronous cost: $0.010000");
    expect(h.out.join("\n")).toContain("no provider call or storage write");
    expect(h.out.join("\n")).not.toContain("usage input=");
    expect(h.out.join("\n")).not.toContain("Usage:");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.listWrites).toEqual([]);
  });

  it("refuses execute without sole-writer before reading the report or storage", async () => {
    const h = harness();
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute"],
        h.deps,
      ),
    ).rejects.toThrow(/--sole-writer/);
    expect(h.readReport).not.toHaveBeenCalled();
    expect(h.createStorage).not.toHaveBeenCalled();
  });

  it("limits selected actions and synchronizes only the selected manifest and list verdict", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer", "--limit", "1"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.keyPrefix).toContain("rd_a");
    expect(h.writes[0]!.manifest).toMatchObject({
      novelty_verdict: "familiar",
      connections: [{ id: "rd_b", reason: "related" }],
      connections_computed_at: JUDGED_AT,
      connections_neighbourhood_ids: ["rd_b"],
      updated_at: "2026-01-01T00:00:00.000Z",
      future_field: { keep: "rd_a" },
    });
    expect(h.items().find((row) => row.id === "rd_a")?.novelty_verdict).toBe("familiar");
    expect(h.items().find((row) => row.id === "rd_c")?.novelty_verdict).toBe("novel");
  });

  it("prints the provider usage per judgement and a run total", async () => {
    const h = harness();
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.out.join("\n")).toContain("rd_a  usage input=100 output=20 reasoning=0");
    expect(h.out.join("\n")).toContain("rd_c  usage input=100 output=20 reasoning=0");
    expect(h.out.join("\n")).toContain("Usage: 2 judgements; input=200 output=40 reasoning=0");
  });

  it("counts the usage of a judgement whose manifest write then loses CAS", async () => {
    const h = harness({ cas: false });
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer", "--limit", "1"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.out.join("\n")).toContain("Usage: 1 judgement; input=100 output=20 reasoning=0");
  });

  it("does not blind-write or update the list after a manifest CAS loss", async () => {
    const h = harness({ cas: false });
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer", "--limit", "1"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.listWrites).toEqual([]);
    expect(h.err.join("\n")).toMatch(/CAS lost/);
  });

  it("continues after an execution read failure and flushes earlier successes", async () => {
    const h = harness();
    const originalCreateStorage = h.deps.createStorage;
    h.deps.createStorage = async (...args) => {
      const storage = await originalCreateStorage(...args);
      const readManifest = storage.readManifest;
      let rdCReads = 0;
      storage.readManifest = async (keyPrefix) => {
        if (keyPrefix.endsWith("rd_c") && ++rdCReads === 2) {
          throw new Error("temporary R2 read failure");
        }
        return readManifest(keyPrefix);
      };
      return storage;
    };
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.listWrites).toHaveLength(1);
    expect(h.err.join("\n")).toContain("rd_c: temporary R2 read failure");
    expect(h.out.join("\n")).toContain("Judged: 1; list rows healed: 0; failures: 1");
  });

  it("drops a provider connection when the neighbour manifest is missing", async () => {
    const h = harness();
    h.manifests.delete("readings/2026/rd_b");
    expect(
      await corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer", "--limit", "1"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.writes[0]!.manifest.connections).toEqual([]);
  });

  it("rejects a report when a target was reprocessed after it was generated", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("readings/2026/rd_a")!.manifest.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        h.deps,
      ),
    ).rejects.toThrow(/target rd_a changed.*regenerate/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("rejects a report when a candidate neighbour was reprocessed after it was generated", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("readings/2026/rd_b")!.manifest.updated_at = JUDGED_AT;
    await expect(
      corpusRefreshConnectionsCommand.run(
        ["--tenant", "global", "--execute", "--sole-writer"],
        h.deps,
      ),
    ).rejects.toThrow(/neighbour rd_b changed.*regenerate/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("reports an invalid target manifest as an incomplete plan", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    delete h.manifests.get("readings/2026/rd_a")!.manifest.content_type;
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_a.*invalid or mismatched/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("reports a target without usable stored summary text as incomplete", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a"])));
    h.manifests.get("readings/2026/rd_a")!.manifest.summary_markdown = "  ";
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/rd_a.*no stored summary text/);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("continues planning but fails the run when a candidate manifest cannot be read", async () => {
    const h = harness();
    h.readReport.mockResolvedValue(JSON.stringify(report(["rd_a", "rd_c"])));
    const originalRead = h.deps.createStorage;
    h.deps.createStorage = async (...args) => {
      const storage = await originalRead(...args);
      const readManifest = storage.readManifest;
      storage.readManifest = async (keyPrefix) => {
        if (keyPrefix.endsWith("rd_b")) throw new Error("invalid JSON");
        return readManifest(keyPrefix);
      };
      return storage;
    };
    expect(
      await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("candidate rd_b: invalid JSON");
    expect(h.err.join("\n")).toContain("invalid candidate manifest(s): rd_b");
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("heals a list write failure on rerun without another paid judgement", async () => {
    const h = harness({ failListOnce: true });
    const argv = [
      "--tenant",
      "global",
      "--execute",
      "--sole-writer",
      "--limit",
      "1",
    ];
    expect(await corpusRefreshConnectionsCommand.run(argv, h.deps)).toBe(1);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.items().find((row) => row.id === "rd_a")?.novelty_verdict).toBe("novel");

    expect(await corpusRefreshConnectionsCommand.run(argv, h.deps)).toBe(0);
    expect(h.judge).toHaveBeenCalledOnce();
    expect(h.items().find((row) => row.id === "rd_a")?.novelty_verdict).toBe("familiar");
  });
});

/**
 * A minimal R2InventoryClient that records every method call, so a test can
 * assert how many requests one manifest read costs.
 */
function fakeInventoryClient(objects: Map<string, { body: string; etag: string }>) {
  const calls: string[] = [];
  const client = {
    async get(key: string) {
      calls.push(`get ${key}`);
      return objects.get(key)?.body ?? null;
    },
    async getWithEtag(key: string) {
      calls.push(`getWithEtag ${key}`);
      const found = objects.get(key);
      return found ? { body: found.body, etag: found.etag } : null;
    },
    async listObjects(prefix?: string) {
      calls.push(`listObjects ${prefix ?? ""}`);
      return [...objects.entries()]
        .filter(([key]) => prefix === undefined || key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.body.length, etag: value.etag }));
    },
    async put(key: string) {
      calls.push(`put ${key}`);
    },
    async putIfAbsent() {
      return true;
    },
    async putIfMatch(key: string, _body: unknown, etag: string) {
      calls.push(`putIfMatch ${key} ${etag}`);
      return true;
    },
    async head() {
      return true;
    },
    async delete() {},
    async listKeys() {
      return [...objects.keys()];
    },
    async getBytes() {
      return null;
    },
  } as unknown as R2InventoryClient;
  return { client, calls };
}

describe("storageFromClient", () => {
  const key = "t/readings/2026/rd_a/manifest.json";

  it("reads a manifest with a single request", async () => {
    const { client, calls } = fakeInventoryClient(
      new Map([[key, { body: JSON.stringify(manifest("rd_a")), etag: "e-a" }]]),
    );
    const storage = storageFromClient(client, "t/");

    await expect(storage.readManifest("readings/2026/rd_a")).resolves.toEqual({
      manifest: manifest("rd_a"),
      etag: "e-a",
    });
    // One GET, not the LIST+GET pair this used to need for the ETag.
    expect(calls).toEqual([`getWithEtag ${key}`]);
  });

  it("returns null for a manifest that is not there", async () => {
    const { client, calls } = fakeInventoryClient(new Map());
    const storage = storageFromClient(client, "t/");

    await expect(storage.readManifest("readings/2026/rd_a")).resolves.toBeNull();
    expect(calls).toEqual([`getWithEtag ${key}`]);
  });

  it("rejects a manifest body that is not a JSON object", async () => {
    const { client } = fakeInventoryClient(new Map([[key, { body: "[1,2]", etag: "e-a" }]]));
    const storage = storageFromClient(client, "t/");

    await expect(storage.readManifest("readings/2026/rd_a")).rejects.toThrow(
      /manifest readings\/2026\/rd_a is not an object/,
    );
  });

  it("refuses a manifest read that carried no ETag", async () => {
    const { client } = fakeInventoryClient(
      new Map([[key, { body: JSON.stringify(manifest("rd_a")), etag: "" }]]),
    );
    const storage = storageFromClient(client, "t/");

    // An empty token would fail the later If-Match, after the judgement is paid.
    await expect(storage.readManifest("readings/2026/rd_a")).rejects.toThrow(
      /manifest readings\/2026\/rd_a was read without an ETag/,
    );
  });

  it("passes the ETag from the read straight back to the CAS write", async () => {
    const { client, calls } = fakeInventoryClient(
      new Map([[key, { body: JSON.stringify(manifest("rd_a")), etag: "e-a" }]]),
    );
    const storage = storageFromClient(client, "t/");

    const stored = await storage.readManifest("readings/2026/rd_a");
    await storage.putManifestIfMatch("readings/2026/rd_a", { id: "rd_a" }, stored!.etag);
    expect(calls).toEqual([`getWithEtag ${key}`, `putIfMatch ${key} e-a`]);
  });
});

/** Tracks overlap and resolves later ids first, so ordering cannot be luck. */
function trackingStorage(
  items: ReturnType<typeof listRow>[],
  manifests: Map<string, { manifest: Record<string, unknown>; etag: string }>,
) {
  let inFlight = 0;
  let peak = 0;
  const completed: string[] = [];
  const storage: RefreshConnectionsStorage = {
    readListIndex: async () => items,
    readManifest: async (keyPrefix) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later key prefixes finish first, so an in-order result can only come
      // from collecting by input position rather than by completion.
      await new Promise((resolve) => setTimeout(resolve, keyPrefix.endsWith("9") ? 0 : 2));
      inFlight--;
      completed.push(keyPrefix);
      return manifests.get(keyPrefix) ?? null;
    },
    putManifestIfMatch: async () => true,
    writeListIndex: async () => {},
  };
  return { storage, peak: () => peak, completed };
}

describe("ops corpus refresh-connections planning read concurrency", () => {
  const COUNT = 20;
  const ids = Array.from({ length: COUNT }, (_, i) => `rd_${String(i).padStart(2, "0")}`);
  const neighbourOf = (id: string) => `nb_${id.slice(3)}`;

  function scaled() {
    const items = [...ids, ...ids.map(neighbourOf)].map(listRow);
    const manifests = new Map(
      items.map((row) => [row.key_prefix, { manifest: manifest(row.id), etag: `e-${row.id}` }]),
    );
    const tracked = trackingStorage(items, manifests);
    const h = harness();
    const scaledReport = {
      ...report(),
      readings: ids.map((id) => ({
        id,
        key_prefix: `readings/2026/${id}`,
        url: `https://example.com/${id}`,
        reasons: ["new_neighbour"],
        novelty_verdict: "novel",
        connections: [],
        current_neighbours: [
          {
            id: neighbourOf(id),
            score: 0.9,
            title: neighbourOf(id),
            tldr: `Summary ${neighbourOf(id)}`,
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      })),
    };
    h.readReport.mockResolvedValue(JSON.stringify(scaledReport));
    h.createStorage.mockResolvedValue(tracked.storage);
    return { h, tracked };
  }

  it("overlaps planning reads up to the cap and keeps plan output in report order", async () => {
    const { h, tracked } = scaled();

    expect(await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps)).toBe(0);

    expect(tracked.peak()).toBe(8);
    // Proof the fixture actually completes out of order, so the assertion below
    // is about collection order rather than a coincidentally serial run.
    expect(tracked.completed).not.toEqual([...tracked.completed].sort());
    const planned = h.out
      .filter((line) => line.includes("  judge reasons="))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(planned).toEqual(ids);
  });

  it("reads every manifest once across both planning waves", async () => {
    const { h, tracked } = scaled();

    expect(await corpusRefreshConnectionsCommand.run(["--tenant", "global"], h.deps)).toBe(0);

    expect(tracked.completed).toHaveLength(COUNT * 2);
    expect(new Set(tracked.completed).size).toBe(COUNT * 2);
  });
});
