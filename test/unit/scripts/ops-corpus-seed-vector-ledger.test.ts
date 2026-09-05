// `ops corpus seed-vector-ledger` — the one-off back-fill that must run on any
// existing corpus before the ledger becomes the wipe's termination condition.
//
// The failure this command prevents is quiet and total: wipe a tenant whose
// corpus predates the ledger and the wipe finds no rows, submits no deletes,
// empties R2, and reports a clean completion with the whole embedding corpus
// intact and — R2 now being gone — unaddressable forever.

import { describe, expect, it } from "vitest";
import {
  collectCorpusReadingIds,
  corpusSeedVectorLedgerCommand,
  type CorpusSeedVectorLedgerDeps,
  type SeedLedgerStorage,
} from "../../../scripts/ops-lib/commands/corpus-seed-vector-ledger";
import { UsageError } from "../../../scripts/ops-lib/contract";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const ROOT = `u/${TENANT}/`;
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function listIndex(ids: string[]): string {
  return JSON.stringify({
    version: 1,
    items: ids.map((id) => ({
      id,
      key_prefix: `readings/2026/04/26T200000Z-${id}`,
      url: `https://example.com/${id}`,
      status: "ready",
      created_at: "2026-04-26T20:00:00.000Z",
    })),
  });
}

function harness(objects: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const ledgered: string[] = [];
  const ledgersMade: Array<{ tenant: string; bucket: string; execute: boolean }> = [];
  const storage: SeedLedgerStorage = {
    listObjectKeys: async (prefix) => Object.keys(objects).filter((k) => k.startsWith(prefix)),
    get: async (key) => objects[key] ?? null,
  };
  const deps: CorpusSeedVectorLedgerDeps = {
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    createStorage: async () => storage,
    makeLedger: (opts) => {
      ledgersMade.push({
        tenant: opts.tenant.kind === "tenant" ? opts.tenant.tenantId : "global",
        bucket: opts.bucket,
        execute: opts.execute,
      });
      return {
        insertMissing: async (ids) => {
          ledgered.push(...ids);
          return ids.length;
        },
      };
    },
    now: () => NOW,
  };
  return { deps, out, err, ledgered, ledgersMade, storage };
}

const run = (argv: string[], deps: CorpusSeedVectorLedgerDeps) =>
  corpusSeedVectorLedgerCommand.run(argv, deps);

const CORPUS = {
  [`${ROOT}index/list.json`]: listIndex(["rd_0123456789"]),
  [`${ROOT}index/by-id/rd_ABCDEFGHJK`]: "{}",
  [`${ROOT}readings/2026/04/26T200000Z-rd_MNPQRSTVWX/manifest.json`]: "{}",
};

describe("ops corpus seed-vector-ledger — the walk", () => {
  it("unions all three id sources rather than trusting any one of them", async () => {
    // list.json can be stale, index/by-id/ can be missing an entry a partial
    // purge left behind, and the readings/ key layout carries the id in a path
    // neither of the others touches. A missing row is unrecoverable, so the walk
    // is the widest one available.
    expect(await collectCorpusReadingIds(harness(CORPUS).storage, ROOT)).toEqual([
      "rd_0123456789",
      "rd_ABCDEFGHJK",
      "rd_MNPQRSTVWX",
    ]);
  });

  it("skips ids outside the Crockford alphabet rather than seeding them", async () => {
    // parseReadingId's alphabet has no I, L, O or U. S6's staging drill lost a
    // whole seeding pass to generating ids from a full base32 alphabet: the
    // wipe's own walk silently skipped them, emptied their objects, and
    // stranded their vectors (observation O1). The walk must agree with the
    // wipe about what an id is, character for character.
    const { storage } = harness({
      [`${ROOT}index/by-id/rd_IIIIIIIIII`]: "{}",
      [`${ROOT}index/by-id/rd_0123456789`]: "{}",
    });
    expect(await collectCorpusReadingIds(storage, ROOT)).toEqual(["rd_0123456789"]);
  });

  it("survives a corrupt list index instead of failing the seed", async () => {
    // An unparseable index contributes nothing; the two R2 walks still run. The
    // alternative — refusing to seed at all — leaves the corpus un-ledgered,
    // which is the state that makes a wipe report a false clean.
    const { storage } = harness({
      [`${ROOT}index/list.json`]: "{not json",
      [`${ROOT}index/by-id/rd_0123456789`]: "{}",
    });
    expect(await collectCorpusReadingIds(storage, ROOT)).toEqual(["rd_0123456789"]);
  });

  it("does not reach outside the tenant key root", async () => {
    const { storage } = harness({
      [`${ROOT}index/by-id/rd_0123456789`]: "{}",
      // Another tenant's object, and a pre-tenant global one.
      "u/usr_22222222-2222-4222-8222-222222222222/index/by-id/rd_ABCDEFGHJK": "{}",
      "index/by-id/rd_MNPQRSTVWX": "{}",
    });
    expect(await collectCorpusReadingIds(storage, ROOT)).toEqual(["rd_0123456789"]);
  });
});

describe("ops corpus seed-vector-ledger — plan and execute", () => {
  it("plan mode lists what it would seed and writes nothing", async () => {
    const h = harness(CORPUS);
    const code = await run(["--tenant", TENANT], h.deps);
    expect(code).toBe(0);
    expect(h.ledgered).toEqual([]);
    const text = h.out.join("\n");
    expect(text).toContain("Mode: PLAN");
    expect(text).toContain("Reading ids derived from the corpus: 3");
    expect(text).toContain("rd_0123456789");
    expect(text).toContain("nothing was written");
    // Plan mode still resolves the ledger, and asks for the no-op by passing
    // execute:false — so an unrecognised --bucket is refused before any write.
    expect(h.ledgersMade).toEqual([{ tenant: TENANT, bucket: "reading-lite", execute: false }]);
  });

  it("--execute writes a live row for every derived id", async () => {
    const h = harness(CORPUS);
    const code = await run(["--tenant", TENANT, "--execute"], h.deps);
    expect(code).toBe(0);
    expect(h.ledgered).toEqual(["rd_0123456789", "rd_ABCDEFGHJK", "rd_MNPQRSTVWX"]);
    expect(h.out.join("\n")).toContain("Seeded 3 vector_ledger row(s)");
    expect(h.ledgersMade).toEqual([{ tenant: TENANT, bucket: "reading-lite", execute: true }]);
  });

  it("is idempotent: a second execute writes the same rows again, harmlessly", async () => {
    const h = harness(CORPUS);
    await run(["--tenant", TENANT, "--execute"], h.deps);
    await run(["--tenant", TENANT, "--execute"], h.deps);
    // Rows are upserts keyed by (tenant_id, reading_id), so re-running finishes
    // a partial seed rather than duplicating anything.
    expect(h.ledgered).toHaveLength(6);
  });

  it("honours --limit, and says so, without pretending the seed is complete", async () => {
    const h = harness(CORPUS);
    await run(["--tenant", TENANT, "--execute", "--limit", "1"], h.deps);
    expect(h.ledgered).toEqual(["rd_0123456789"]);
    expect(h.out.join("\n")).toContain("Limited to the first 1");
  });

  it("refuses --tenant global", async () => {
    // vector_ledger.tenant_id references users(id); the pre-tenant corpus has
    // no such id and no account wipe addresses it.
    const h = harness(CORPUS);
    await expect(run(["--tenant", "global", "--execute"], h.deps)).rejects.toThrow(UsageError);
    expect(h.ledgered).toEqual([]);
  });

  it("refuses a bucket with no control plane, in plan mode as well as execute", async () => {
    // The rows have to go somewhere. A plan that succeeds against a bucket the
    // execute would reject is worse than no plan: the operator learns about it
    // only after committing to --execute.
    const h = harness(CORPUS);
    await expect(run(["--tenant", TENANT, "--bucket", "nope"], h.deps)).rejects.toThrow(UsageError);
    await expect(
      run(["--tenant", TENANT, "--bucket", "nope", "--execute"], h.deps),
    ).rejects.toThrow(UsageError);
    expect(h.ledgered).toEqual([]);
  });

  it("refuses a missing or malformed tenant selector", async () => {
    const h = harness(CORPUS);
    await expect(run([], h.deps)).rejects.toThrow(UsageError);
    await expect(run(["--tenant", "nope"], h.deps)).rejects.toThrow(UsageError);
    expect(h.ledgered).toEqual([]);
  });

  it("says plainly that an empty walk is not proof of an empty corpus", async () => {
    const h = harness({});
    const code = await run(["--tenant", TENANT, "--execute"], h.deps);
    expect(code).toBe(0);
    expect(h.ledgered).toEqual([]);
    const text = h.out.join("\n");
    expect(text).toContain("check --bucket and --tenant");
  });

  it("registers plan-first, with the tenant selector and the rollout order in its help", async () => {
    expect(corpusSeedVectorLedgerCommand.group).toBe("corpus");
    expect(corpusSeedVectorLedgerCommand.safety).toBe("plan-first");
    const help = corpusSeedVectorLedgerCommand.helpText;
    expect(help).toContain("--execute");
    expect(help).toContain("--tenant");
    // What it is NOT is the load-bearing part now: the wipe seeds itself, so
    // an operator must not be told this is a prerequisite for deletion.
    expect(help).toMatch(/NOT A PREREQUISITE FOR DELETION/i);
    expect(help).not.toMatch(/MUST RUN THIS/i);
  });
});
