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

const TENANT = "usr_11111111-1111-4111-8111-111111111111";

const FAILED_ITEM: ListItem = {
  id: "rd_f", url: "https://a.example/x", status: "failed",
  created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_f",
};

const READY_ITEM: ListItem = {
  id: "rd_r", url: "https://a.example/y", status: "ready",
  created_at: "2026-08-02T00:00:00Z", key_prefix: "readings/rd_r",
};

// One fake behind both drop and sweep: they share the delete discipline
// (objects first, row last, per reading) and differ only in how they choose
// their targets.
function corpusFake(items: ListItem[], opts: { keys?: Record<string, string[]>; missingRows?: string[] } = {}) {
  const deletedRows: string[] = [];
  const view = {
    listItems: async () => items,
    contentKeysForDrop: async (id: string) => opts.keys?.[id] ?? [`readings/${id}/revisions/at_1/raw.html`],
    deleteReading: async (id: string) => {
      if (opts.missingRows?.includes(id)) return false;
      deletedRows.push(id);
      return true;
    },
    deleteInboundRelationships: async () => 0,
    manifest: async () => null,
  };
  return { view, deletedRows };
}

function dropDeps(
  items: ListItem[],
  opts: { keys?: Record<string, string[]>; deleteResult?: (key: string) => "deleted" | "absent" | "error"; missingRows?: string[] } = {},
): { deps: CorpusDropDeps; lines: string[]; deletedRows: string[]; deletedKeys: string[] } {
  const { io: cio, lines } = io();
  const { view, deletedRows } = corpusFake(items, opts);
  const deletedKeys: string[] = [];
  const deps: CorpusDropDeps = {
    io: cio,
    corpus: async (_env, tenant, run) => {
      if (tenant.kind === "global") throw new UsageError("--tenant global has no PostgreSQL corpus");
      return run(view as never);
    },
    r2: {
      deleteObject: async (key) => {
        deletedKeys.push(key);
        return opts.deleteResult?.(key) ?? "deleted";
      },
    },
  };
  return { deps, lines, deletedRows, deletedKeys };
}

describe("ops corpus drop", () => {
  it("plans without deleting anything", async () => {
    const { deps, lines, deletedRows, deletedKeys } = dropDeps([FAILED_ITEM]);
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_f"], deps);
    expect(code).toBe(0);
    expect(deletedKeys).toEqual([]);
    expect(deletedRows).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("would delete  readings/rd_f/revisions/at_1/raw.html");
    expect(text).toContain("would delete  row rd_f");
    expect(text).toContain("PLAN");
  });

  it("deletes the content, then the row", async () => {
    const { deps, deletedRows, deletedKeys, lines } = dropDeps([FAILED_ITEM]);
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_f", "--execute"], deps);
    expect(code).toBe(0);
    expect(deletedKeys).toEqual(["readings/rd_f/revisions/at_1/raw.html"]);
    expect(deletedRows).toEqual(["rd_f"]);
    // Ordering is the point: the row is what makes the bytes findable.
    const text = lines.join("\n");
    expect(text.indexOf("deleted   readings/rd_f")).toBeLessThan(text.indexOf("deleted   row rd_f"));
  });

  it("keeps the row when one of its objects fails to delete, so the drop is re-runnable", async () => {
    const { deps, deletedRows, lines } = dropDeps([FAILED_ITEM], {
      keys: { rd_f: ["k1", "k2"] },
      deleteResult: (key) => (key === "k2" ? "error" : "deleted"),
    });
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_f", "--execute"], deps);
    expect(code).toBe(1);
    expect(deletedRows).toEqual([]);
    expect(lines.join("\n")).toContain("keeping row rd_f");
  });

  it("one reading's failure does not hold back another's row", async () => {
    const second: ListItem = { ...FAILED_ITEM, id: "rd_g", url: "https://a.example/z", key_prefix: "readings/rd_g" };
    const { deps, deletedRows } = dropDeps([FAILED_ITEM, second], {
      keys: { rd_f: ["bad"], rd_g: ["good"] },
      deleteResult: (key) => (key === "bad" ? "error" : "deleted"),
    });
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_f", "rd_g", "--execute"], deps);
    expect(code).toBe(1);
    expect(deletedRows).toEqual(["rd_g"]);
  });

  it("treats an already-deleted row as a successful no-op", async () => {
    const { deps, lines } = dropDeps([FAILED_ITEM], { missingRows: ["rd_f"] });
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_f", "--execute"], deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("already gone  row rd_f");
  });

  it("refuses a named ready id without --allow-ready", async () => {
    const { deps, lines, deletedRows } = dropDeps([READY_ITEM]);
    const code = await corpusDropCommand.run(["--tenant", TENANT, "rd_r"], deps);
    expect(code).toBe(1);
    expect(deletedRows).toEqual([]);
    expect(lines.join("\n")).toContain("refusing rd_r");
  });

  it("refuses --allow-ready against the production bucket", async () => {
    const { deps } = dropDeps([READY_ITEM]);
    await expect(
      corpusDropCommand.run(["--tenant", TENANT, "rd_r", "--allow-ready", "--bucket", "reading-lite"], deps),
    ).rejects.toThrow(UsageError);
  });

  it("no longer requires a Vectorize index for --allow-ready: the embedding cascades", async () => {
    const { deps, deletedRows } = dropDeps([READY_ITEM]);
    const code = await corpusDropCommand.run(
      ["--tenant", TENANT, "rd_r", "--allow-ready", "--bucket", "reading-lite-staging", "--execute"],
      deps,
    );
    expect(code).toBe(0);
    expect(deletedRows).toEqual(["rd_r"]);
  });

  it("rejects --vectorize, which no longer means anything", async () => {
    const { deps } = dropDeps([FAILED_ITEM]);
    await expect(
      corpusDropCommand.run(["--tenant", TENANT, "rd_f", "--vectorize", "reading-lite"], deps),
    ).rejects.toThrow(UsageError);
  });

  it("requires a tenant and refuses global", async () => {
    const { deps } = dropDeps([FAILED_ITEM]);
    await expect(corpusDropCommand.run(["rd_f"], deps)).rejects.toThrow(UsageError);
    await expect(corpusDropCommand.run(["--tenant", "global", "rd_f"], deps)).rejects.toThrow(UsageError);
  });

  it("requires at least one selector", async () => {
    const { deps } = dropDeps([FAILED_ITEM]);
    await expect(corpusDropCommand.run(["--tenant", TENANT], deps)).rejects.toThrow(UsageError);
  });
});

describe("ops corpus sweep", () => {
  const A: ListItem = {
    id: "rd_a", url: "https://youtu.be/X", status: "ready",
    created_at: "2026-08-01T00:00:00Z", key_prefix: "readings/rd_a",
  };
  const B: ListItem = {
    id: "rd_b", url: "https://www.youtube.com/watch?v=X", status: "failed",
    created_at: "2026-08-02T00:00:00Z", key_prefix: "readings/rd_b",
  };

  function sweepDeps(
    items: ListItem[],
    opts: { deleteResult?: (key: string) => "deleted" | "absent" | "error" } = {},
  ): { deps: CorpusSweepDeps; lines: string[]; deletedRows: string[] } {
    const { io: cio, lines } = io();
    const { view, deletedRows } = corpusFake(items);
    const deps: CorpusSweepDeps = {
      io: cio,
      corpus: async (_env, tenant, run) => {
        if (tenant.kind === "global") throw new UsageError("--tenant global has no PostgreSQL corpus");
        return run(view as never);
      },
      r2: { deleteObject: async (key) => opts.deleteResult?.(key) ?? "deleted" },
    };
    return { deps, lines, deletedRows };
  }

  it("keeps the ready copy and plans to drop the duplicate", async () => {
    const { deps, lines, deletedRows } = sweepDeps([A, B]);
    const code = await corpusSweepCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(0);
    expect(deletedRows).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("keep  rd_a");
    expect(text).toContain("drop  rd_b");
    expect(text).toContain("would delete  row rd_b");
  });

  it("drops the duplicate's content and row on --execute", async () => {
    const { deps, deletedRows } = sweepDeps([A, B]);
    const code = await corpusSweepCommand.run(["--tenant", TENANT, "--execute"], deps);
    expect(code).toBe(0);
    expect(deletedRows).toEqual(["rd_b"]);
  });

  it("keeps the row when an object delete fails", async () => {
    const { deps, deletedRows, lines } = sweepDeps([A, B], { deleteResult: () => "error" });
    const code = await corpusSweepCommand.run(["--tenant", TENANT, "--execute"], deps);
    expect(code).toBe(1);
    expect(deletedRows).toEqual([]);
    expect(lines.join("\n")).toContain("keeping row rd_b");
  });

  it("reports nothing to sweep when there are no duplicates", async () => {
    const { deps, lines } = sweepDeps([A]);
    const code = await corpusSweepCommand.run(["--tenant", TENANT], deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("No duplicate groups found");
  });

  it("rejects --vectorize, which no longer means anything", async () => {
    const { deps } = sweepDeps([A, B]);
    await expect(
      corpusSweepCommand.run(["--tenant", TENANT, "--vectorize", "reading-lite"], deps),
    ).rejects.toThrow(UsageError);
  });

  it("refuses --drop without exactly one --keep", async () => {
    const { deps } = sweepDeps([A, B]);
    await expect(corpusSweepCommand.run(["--tenant", TENANT, "--drop", "rd_b"], deps)).rejects.toThrow(UsageError);
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

  it("lets --tenant global past the ledger guard on any bucket", async () => {
    // The pre-tenant corpus has no tenant id to key ledger rows by, and no
    // account wipe addresses it, so the ledger guard has nothing to refuse.
    // Run in execute mode: plan mode swallows a ledger refusal and still exits
    // 0. The run gets past that guard and stops only at the next one: a bucket
    // with no spend authority cannot admit the batch (reading-lite-gh319.2).
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
