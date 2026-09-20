import { BILLING_TENANT, spendHarness } from "../../helpers/operator-spend";
import { describe, expect, it } from "vitest";
import { corpusDropCommand, type CorpusDropDeps } from "../../../scripts/ops-lib/commands/corpus-drop";
import { corpusSweepCommand, type CorpusSweepDeps } from "../../../scripts/ops-lib/commands/corpus-sweep";
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







describe("ops corpus ingest", () => {
  function makeDeps() {
    const { io: cio, lines } = io();
    const calls = {
      dirReads: 0, sidecarLoads: 0, configResolves: 0,
      ownershipPlans: 0, executes: 0, sidecarClears: 0,
    };
    const spend = spendHarness();
    const paid: Array<{ spend: { tenantId: string } }> = [];
    const deps: CorpusIngestDeps = {
      io: cio,
      openSpend: spend.openSpend,
      fetch: spend.fetch,
      now: () => 0,
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
        // spend admission reads, and a double that omitted them would make the
        // command look broken for a reason the test is not about.
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
      executeBatch: async (_eligible, _cfg, opts) => {
        calls.executes++;
        paid.push(opts.paid);
        return { report: [{ status: "ready" }] as never, dropped: [], resumed: false, batchId: "b1", dispositions: [] };
      },
    };
    return { deps, lines, calls, spend, paid };
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

  it("refuses a bucket with no spend authority before submitting", async () => {
    // Run in execute mode: plan mode degrades gracefully and still exits 0.
    // A bucket with no spend authority cannot admit the batch
    // (reading-lite-gh319.2), and it has to stop the run before the paid
    // submit rather than half way through a resumable pass.
    const { deps, calls, spend } = makeDeps();
    deps.resolveConfig = (flags) => {
      calls.configResolves++;
      return { tenant: flags.tenant, r2: { bucket: "some-scratch-bucket" } } as never;
    };
    await expect(corpusIngestCommand.run(
      ["--tenant", "global", "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    )).rejects.toThrow(/no spend authority is mapped to bucket 'some-scratch-bucket'/);
    expect(spend.openSpend).not.toHaveBeenCalled();
    expect(calls.executes).toBe(0);
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
    const code = await corpusIngestCommand.run(
      ["--tenant", "global", "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
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
      ["--tenant", "global", "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls.executes).toBe(1);
  });

  it("rejects a malformed --limit", async () => {
    const { deps } = makeDeps();
    await expect(corpusIngestCommand.run(["--tenant", "global", "--dir", "/md", "--limit", "zero"], deps)).rejects.toThrow(UsageError);
  });

  // reading-lite-gh319.2. These also own the batch payer rules
  // (resolveBatchBillingTenant); corpus recover shares them.
  describe("spend admission", () => {
    const TENANT = "usr_11111111-1111-4111-8111-111111111111";
    const ADMITTED_PAYER = "usr_33333333-3333-4333-8333-333333333333";
    const inFlight = (payer?: string) =>
      ({ batchId: "b1", targets: [], provider: "openai", ...(payer ? { spend: { tenantId: payer } } : {}) }) as never;
    const EXECUTE = ["--dir", "/md", "--execute", "--sole-writer"];

    it.each([
      ["a fresh plan", null],
      ["a resume plan", inFlight(ADMITTED_PAYER)],
    ])("%s opens no spend session", async (_label, sidecar) => {
      const { deps, spend } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      expect(await corpusIngestCommand.run(["--tenant", "global", "--dir", "/md"], deps)).toBe(0);
      expect(spend.openSpend).not.toHaveBeenCalled();
    });

    it.each([
      ["a real --tenant pays by default", ["--tenant", TENANT], null, TENANT],
      ["--tenant global pays with --billing-tenant", ["--tenant", "global", "--billing-tenant", BILLING_TENANT], null, BILLING_TENANT],
      ["a resume pays with the tenant its batch was admitted under", ["--tenant", "global"], inFlight(ADMITTED_PAYER), ADMITTED_PAYER],
      ["a resume may name that same tenant", ["--tenant", "global", "--billing-tenant", ADMITTED_PAYER], inFlight(ADMITTED_PAYER), ADMITTED_PAYER],
    ])("%s, through the bucket's spend authority", async (_label, flags, sidecar, payer) => {
      const { deps, spend, paid } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      expect(await corpusIngestCommand.run([...flags, ...EXECUTE], deps)).toBe(0);
      expect(spend.openSpend).toHaveBeenCalledWith("production");
      expect(paid.map((p) => p.spend.tenantId)).toEqual([payer]);
      expect(spend.dispose).toHaveBeenCalledOnce();
    });

    it.each([
      ["--tenant global without --billing-tenant", ["--tenant", "global"], null, /--execute requires --billing-tenant/],
      ["a resume naming a different payer", ["--tenant", "global", "--billing-tenant", BILLING_TENANT], inFlight(ADMITTED_PAYER), /admitted against billing tenant/],
      ["a batch submitted before spend accounting, under --tenant global", ["--tenant", "global"], inFlight(), /--execute requires --billing-tenant/],
    ])("refuses %s before any spend session or batch", async (_label, flags, sidecar, refusal) => {
      const { deps, spend, calls } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      await expect(corpusIngestCommand.run([...flags, ...EXECUTE], deps)).rejects.toThrow(refusal);
      expect(spend.openSpend).not.toHaveBeenCalled();
      expect(calls.executes).toBe(0);
    });
  });
});
