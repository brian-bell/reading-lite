// `ops corpus purge-legacy` against real reading rows (the rolled-back test
// database) and an in-memory bucket. The classifier's per-key verdicts are
// owned by test/unit/corpus/legacy-objects.test.ts; this file owns the
// command: listing scope, what execute deletes, the re-check before a
// reading's content goes, the orphan limit and the verification pass.
import { describe, expect, it, vi } from "vitest";
import {
  corpusPurgeLegacyCommand,
  type CorpusPurgeLegacyDeps,
} from "../../../scripts/ops-lib/commands/corpus-purge-legacy";
import { UsageError } from "../../../scripts/ops-lib/contract";
import {
  captureIo,
  keyPrefixFor,
  OPERATOR_ENV,
  operatorSession,
  seedReading,
  seedTenant,
  useCorpusDatabase,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();

const A = "rd_0000000001";
const B = "rd_0000000002";
const ORPHAN = "rd_0000000003";
const ORPHAN_CREATED = "2026-05-02T12:00:00.000Z";
const B_CREATED = "2026-01-02T00:00:00.000Z";

function memoryStorage(keys: string[]) {
  const objects = new Set(keys);
  const failOn = new Set<string>();
  let onDelete: ((key: string) => Promise<void>) | undefined;
  return {
    objects,
    failOn,
    setOnDelete: (fn: (key: string) => Promise<void>) => { onDelete = fn; },
    storage: {
      listObjects: vi.fn(async (prefix: string) =>
        [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: 1, etag: "e" })),
      ),
      delete: vi.fn(async (key: string) => {
        if (failOn.has(key)) throw new Error("R2 503");
        await onDelete?.(key);
        objects.delete(key);
      }),
    },
  };
}

// Reading A was reprocessed after import (its legacy content is superseded);
// B was imported and never touched (its revision is the legacy spelling);
// ORPHAN has objects and no row.
async function fixture() {
  const sql = sqlFor();
  const tenant = await seedTenant(sql);
  const other = await seedTenant(sql);
  const root = `u/${tenant.tenantId}/`;
  const pA = keyPrefixFor(A);
  const pB = keyPrefixFor(B, B_CREATED);
  const pO = keyPrefixFor(ORPHAN, ORPHAN_CREATED);
  await seedReading(sql, tenant, A, {
    revision: { id: "rev_a", rawKey: `${pA}/revisions/at_new/raw.html`, extractedKey: `${pA}/revisions/at_new/extracted.md` },
  });
  await seedReading(sql, tenant, B, {
    createdAt: B_CREATED,
    revision: { id: "rev_b", rawKey: `${pB}/raw.html`, extractedKey: `${pB}/extracted.md` },
  });
  const legacy = [
    `${pA}/manifest.json`,
    `${pA}/attempts/at_old.json`,
    `${pA}/raw.html`,
    `${pA}/extracted.md`,
    `${pB}/manifest.json`,
    `${pO}/manifest.json`,
    `${pO}/raw.html`,
    "index/list.json",
    "index/refresh-state.json",
    "index/by-url/abc123",
    `index/by-id/${A}`,
    "index/deleted/rd_0000000009",
  ].map((key) => `${root}${key}`);
  const kept = [
    `${root}${pA}/revisions/at_new/raw.html`,
    `${root}${pA}/revisions/at_new/extracted.md`,
    `${root}${pB}/raw.html`,
    `${root}${pB}/extracted.md`,
    `${root}index/refresh-cursor.json`,
    `${root}exports/exp_1/part-0001.zip`,
    // Another tenant's root, and the pre-tenant global layout.
    `u/${other.tenantId}/index/list.json`,
    `${pA}/manifest.json`,
  ];
  const bucket = memoryStorage([...legacy, ...kept]);
  const session = operatorSession(sqlFor);
  const io = captureIo();
  const deps: CorpusPurgeLegacyDeps = {
    io: io.io,
    openSql: session.openSql,
    env: OPERATOR_ENV,
    createStorage: vi.fn(async () => bucket.storage),
  };
  const run = (...extra: string[]) =>
    corpusPurgeLegacyCommand.run(["--tenant", String(tenant.tenantId), ...extra], deps);
  return { sql, tenant, root, pO, legacy, kept, bucket, deps, io, run };
}

describe("ops corpus purge-legacy", () => {
  it("plans without deleting and names the content it would remove", async () => {
    const f = await fixture();
    expect(await f.run()).toBe(0);
    expect(f.bucket.storage.delete).not.toHaveBeenCalled();
    const out = f.io.all();
    expect(out).toContain("To delete (12):");
    expect(out).toContain(`${keyPrefixFor(A)}/raw.html`);
    expect(out).toContain(`${f.pO}/  2 object(s)`);
    expect(out).toContain("unrecognized  exports/exp_1/part-0001.zip");
    expect(out).toContain("Re-run with --execute --sole-writer");
  });

  it("deletes exactly the tenant's legacy objects, then verifies with a fresh listing", async () => {
    const f = await fixture();
    expect(await f.run("--execute", "--sole-writer")).toBe(0);
    expect([...f.bucket.objects].sort()).toEqual([...f.kept].sort());
    expect(f.io.all()).toContain("Verified");
  });

  // What the wrong database pairing looks like: rows missing, so every prefix
  // is an orphan. Refused before any delete.
  it("refuses to execute when orphan prefixes exceed the limit", async () => {
    const f = await fixture();
    expect(await f.run("--execute", "--sole-writer", "--max-orphan-prefixes", "0")).toBe(1);
    expect(f.bucket.storage.delete).not.toHaveBeenCalled();
  });

  // An import writes its revision objects before claimUrl commits the row, so
  // a rowless prefix may be a claim in flight. Only a paused writer rules that out.
  it("refuses to delete orphan prefixes on --execute without --sole-writer", async () => {
    const f = await fixture();
    expect(await f.run("--execute")).toBe(1);
    expect(f.bucket.storage.delete).not.toHaveBeenCalled();
    expect(f.io.err.join("\n")).toContain("requires --sole-writer");
  });

  // Nothing live writes the other legacy keys, so without orphans no pause is needed.
  it("executes without --sole-writer when the plan has no orphan prefixes", async () => {
    const f = await fixture();
    for (const key of [...f.bucket.objects]) if (key.startsWith(`${f.root}${f.pO}/`)) f.bucket.objects.delete(key);
    expect(await f.run("--execute")).toBe(0);
    expect([...f.bucket.objects].sort()).toEqual([...f.kept].sort());
  });

  it("re-checks an orphan prefix immediately before deleting it", async () => {
    const f = await fixture();
    // The reading's row appears after the plan was built, while bookkeeping
    // objects are being deleted.
    let seeded = false;
    f.bucket.setOnDelete(async () => {
      if (seeded) return;
      seeded = true;
      await seedReading(f.sql, f.tenant, ORPHAN, { createdAt: ORPHAN_CREATED });
    });
    expect(await f.run("--execute", "--sole-writer")).toBe(1);
    expect(f.bucket.objects).toContain(`${f.root}${f.pO}/raw.html`);
    expect(f.bucket.objects).toContain(`${f.root}${f.pO}/manifest.json`);
    expect(f.io.all()).toContain("Skipped after re-check");
  });

  it("fails the run when a delete errors, naming the key", async () => {
    const f = await fixture();
    f.bucket.failOn.add(`${f.root}index/list.json`);
    expect(await f.run("--execute", "--sole-writer")).toBe(1);
    expect(f.io.err.join("\n")).toContain("delete error  index/list.json");
    expect(f.bucket.objects).toContain(`${f.root}index/list.json`);
  });

  it("refuses --tenant global before touching storage", async () => {
    const f = await fixture();
    await expect(
      corpusPurgeLegacyCommand.run(["--tenant", "global", "--execute"], f.deps),
    ).rejects.toBeInstanceOf(UsageError);
    expect(f.deps.createStorage).not.toHaveBeenCalled();
  });
});
