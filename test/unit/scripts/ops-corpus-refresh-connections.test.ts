import { describe, expect, it, vi } from "vitest";
import { SIMILARITY_FLOOR } from "../../../src/modules/stores/similarity-store";
import {
  corpusRefreshConnectionsCommand,
  parseProductionWorkerVars,
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

describe("ops corpus refresh-connections", () => {
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
