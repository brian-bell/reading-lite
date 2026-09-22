const TENANT = "usr_22222222-2222-4222-8222-222222222222";
import { BILLING_TENANT, spendHarness } from "../../helpers/operator-spend";
import { describe, expect, it } from "vitest";
import { corpusIngestCommand, type CorpusIngestDeps } from "../../../scripts/ops-lib/commands/corpus-ingest";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
function io(): { io: CommandIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t) }, lines };
}

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
    const code = await corpusIngestCommand.run(["--tenant", TENANT, "--dir", "/md", "--execute"], deps);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("REFUSED");
    expect(calls.dirReads).toBe(0);
    expect(calls.sidecarLoads).toBe(0);
    expect(calls.executes).toBe(0);
  });

  it("plan mode runs the ownership check but never submits", async () => {
    const { deps, calls, lines } = makeDeps();
    const code = await corpusIngestCommand.run(["--tenant", TENANT, "--dir", "/md"], deps);
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
      ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
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
    const code = await corpusIngestCommand.run(["--tenant", TENANT, "--dir", "/md"], deps);
    expect(code).toBe(0);
    expect(calls.ownershipPlans).toBe(0);
    expect(calls.executes).toBe(0);
    expect(lines.join("\n")).toContain("ownership check skipped");
  });

  it("--execute --sole-writer runs the batch and clears the sidecar", async () => {
    const { deps, calls } = makeDeps();
    const code = await corpusIngestCommand.run(
      ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
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
      ["--tenant", TENANT, "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.executes).toBe(0);
    expect(lines.join("\n")).toContain("belongs to tenant 'usr_11111111-1111-4111-8111-111111111111'");
  });

  it("refuses a legacy global sidecar when targeting PostgreSQL", async () => {
    const { deps, calls } = makeDeps();
    deps.loadSidecar = async () =>
      ({ batchId: "b1", targets: [], provider: "openai" }) as never;
    const code = await corpusIngestCommand.run(
      ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT, "--dir", "/md", "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(1);
    expect(calls.executes).toBe(0);
  });

  it("rejects a malformed --limit", async () => {
    const { deps } = makeDeps();
    await expect(corpusIngestCommand.run(["--tenant", TENANT, "--dir", "/md", "--limit", "zero"], deps)).rejects.toThrow(UsageError);
  });

  // reading-lite-gh319.2. These also own the batch payer rules
  // (resolveBatchBillingTenant); corpus recover shares them.
  describe("spend admission", () => {
    const ADMITTED_PAYER = "usr_33333333-3333-4333-8333-333333333333";
    const inFlight = (payer?: string) =>
      ({ batchId: "b1", targets: [], provider: "openai", tenant: TENANT, ...(payer ? { spend: { tenantId: payer } } : {}) }) as never;
    const EXECUTE = ["--dir", "/md", "--execute", "--sole-writer"];

    it.each([
      ["a fresh plan", null],
      ["a resume plan", inFlight(ADMITTED_PAYER)],
    ])("%s opens no spend session", async (_label, sidecar) => {
      const { deps, spend } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      expect(await corpusIngestCommand.run(["--tenant", TENANT, "--dir", "/md"], deps)).toBe(0);
      expect(spend.openSpend).not.toHaveBeenCalled();
    });

    it.each([
      ["a real --tenant pays by default", ["--tenant", TENANT], null, TENANT],
      ["an explicit billing tenant pays", ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], null, BILLING_TENANT],
      ["a resume pays with the tenant its batch was admitted under", ["--tenant", TENANT], inFlight(ADMITTED_PAYER), ADMITTED_PAYER],
      ["a resume may name that same tenant", ["--tenant", TENANT, "--billing-tenant", ADMITTED_PAYER], inFlight(ADMITTED_PAYER), ADMITTED_PAYER],
    ])("%s, through the bucket's spend authority", async (_label, flags, sidecar, payer) => {
      const { deps, spend, paid } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      expect(await corpusIngestCommand.run([...flags, ...EXECUTE], deps)).toBe(0);
      expect(spend.openSpend).toHaveBeenCalledWith("production");
      expect(paid.map((p) => p.spend.tenantId)).toEqual([payer]);
      expect(spend.dispose).toHaveBeenCalledOnce();
    });

    it.each([
      ["a resume naming a different payer", ["--tenant", TENANT, "--billing-tenant", BILLING_TENANT], inFlight(ADMITTED_PAYER), /admitted against billing tenant/],
    ])("refuses %s before any spend session or batch", async (_label, flags, sidecar, refusal) => {
      const { deps, spend, calls } = makeDeps();
      deps.loadSidecar = async () => sidecar;
      await expect(corpusIngestCommand.run([...flags, ...EXECUTE], deps)).rejects.toThrow(refusal);
      expect(spend.openSpend).not.toHaveBeenCalled();
      expect(calls.executes).toBe(0);
    });
  });
});
