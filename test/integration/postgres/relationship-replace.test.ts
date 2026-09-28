// The relationship compare-and-replace the refresh passes write through
// (reading-lite-gh347.4.1). Four properties live here and nowhere else: the
// judged set and its flags land together or not at all, two passes over one
// reading cannot interleave a read and a write, an empty set is
// distinguishable from one never computed, and a target that was deleted while
// the judgement ran leaves no dangling inbound row.
//
// Against a real database, because every one of them is a claim about
// PostgreSQL rather than about our code: a rolled-back transaction, a row lock
// that blocks, a NOT NULL default, a foreign key that covers only one side.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../../../src/modules/db/sql";
import type { PublishedReplacement } from "../../../src/modules/stores/postgres/reading-writer";
import { pgReadingWriterFor } from "../../../src/modules/stores/postgres/reading-writer";
import type { Manifest } from "../../../src/schemas/manifest";
import type { TenantContext } from "../../../src/control-plane/ids";
import { interceptSql } from "../../helpers/sql-faults";
import { mintTenant, readyManifest, seedManifest, testSql } from "../../helpers/pg-fixtures";

const JUDGED_AT = "2026-05-01T12:00:00.000Z";

const open: Sql[] = [];
function sql(): Sql {
  const s = testSql();
  open.push(s);
  return s;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((s) => s.end()));
});

function judged(manifest: Manifest, overrides: Partial<Manifest>): Manifest {
  return { ...manifest, connections_computed_at: JUDGED_AT, ...overrides };
}

// A published reading nobody has judged yet. The fixture manifest carries
// `connections: []`, which is already the "computed, and there were none"
// state — the very thing the empty set below has to be distinguishable from.
async function unjudgedManifest(id: string): Promise<Manifest> {
  const manifest = await readyManifest(id);
  delete (manifest as { connections?: unknown }).connections;
  return manifest;
}

function entry(next: Manifest, matches: PublishedReplacement["matches"] = () => true): PublishedReplacement {
  return { id: next.id, matches, next };
}

async function relationshipRows(
  db: Sql,
  tenant: TenantContext,
  sourceId: string,
): Promise<{ kind: string; target_id: string }[]> {
  return db.query<{ kind: string; target_id: string }>(
    `SELECT kind, target_id FROM reading_relationships
     WHERE tenant_id = $1 AND source_id = $2 ORDER BY kind, target_id`,
    [String(tenant.tenantId), sourceId],
  );
}

async function revisionFlags(
  db: Sql,
  tenant: TenantContext,
  readingId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db.query(
    `SELECT v.connections_present, v.tensions_present, v.connections_computed_at,
            v.connections_neighbourhood_ids, v.tensions_judged
     FROM reading_revisions v
     JOIN readings r ON (r.tenant_id, r.id) = (v.tenant_id, v.reading_id)
                    AND r.current_revision_id = v.id
     WHERE v.tenant_id = $1 AND v.reading_id = $2`,
    [String(tenant.tenantId), readingId],
  );
  return row!;
}

describe("replacePublishedSetIf", () => {
  // The flags are not decoration: relationship rows cannot tell an absent array
  // from an empty one, so a set whose rows landed without its flags reads back
  // as never computed — a judgement silently repeated every night, or worse,
  // rows nothing claims to have computed.
  it("leaves neither the revision flags nor the relationship rows when the write fails midway", async () => {
    const db = sql();
    const tenant = await mintTenant();
    const source = await unjudgedManifest("rd_source");
    await seedManifest(db, tenant, source);
    await seedManifest(db, tenant, await readyManifest("rd_target"));

    interceptSql(/INSERT INTO reading_relationships/, () => new Error("connection terminated"));
    const writer = pgReadingWriterFor(db, tenant);
    await expect(
      writer.replacePublishedSetIf([
        entry(judged(source, { connections: [{ id: "rd_target", reason: "both on locks" }] })),
      ]),
    ).rejects.toThrow("connection terminated");
    vi.restoreAllMocks();

    expect(await relationshipRows(db, tenant, "rd_source")).toEqual([]);
    expect(await revisionFlags(db, tenant, "rd_source")).toMatchObject({
      connections_present: false,
      connections_computed_at: null,
    });
  });

  // Two operator passes over one corpus, or a pass overlapping the hosted
  // nightly judge. Without the lock taken before the read, both read the same
  // manifest and the later write silently discards the earlier judgement.
  it("makes a concurrent replace wait, so its guard reads the committed result", async () => {
    const tenant = await mintTenant();
    const first = sql();
    const second = sql();
    const source = await readyManifest("rd_source");
    await seedManifest(first, tenant, source);
    await seedManifest(first, tenant, await readyManifest("rd_target"));

    let releaseFirst: () => void;
    const firstIsInside = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const firstReplace = pgReadingWriterFor(first, tenant).replacePublishedSetIf([
      entry(judged(source, { connections: [{ id: "rd_target", reason: "first" }] }), async () => {
        firstEntered();
        await firstIsInside;
        return true;
      }),
    ]);
    await entered;

    // Opened while the first holds the row lock: it must block on the lock
    // before its own guard runs.
    const seenBySecond: (string | undefined)[] = [];
    const secondReplace = pgReadingWriterFor(second, tenant).replacePublishedSetIf([
      entry(judged(source, { connections: [{ id: "rd_target", reason: "second" }] }), (current) => {
        seenBySecond.push(current.connections?.[0]?.reason);
        return true;
      }),
    ]);
    // Long enough for an unlocked read to have happened.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seenBySecond).toEqual([]);

    releaseFirst!();
    expect(await firstReplace).toEqual({ replaced: true, skippedTargets: [] });
    expect(await secondReplace).toEqual({ replaced: true, skippedTargets: [] });
    // The second's guard ran against the first's committed manifest, which is
    // the whole point: it decided on what is there, not on what was.
    expect(seenBySecond).toEqual(["first"]);
    expect(await relationshipRows(first, tenant, "rd_source")).toEqual([
      { kind: "connection", target_id: "rd_target" },
    ]);
  });

  it("replaces the whole previous set, and records an empty set as computed rather than absent", async () => {
    const db = sql();
    const tenant = await mintTenant();
    const source = await readyManifest("rd_source");
    await seedManifest(db, tenant, source);
    await seedManifest(db, tenant, await readyManifest("rd_b"));
    await seedManifest(db, tenant, await unjudgedManifest("rd_a"));
    const writer = pgReadingWriterFor(db, tenant);

    await writer.replacePublishedSetIf([
      entry(
        judged(source, {
          connections: [
            { id: "rd_a", reason: "a" },
            { id: "rd_b", reason: "b" },
          ],
          connections_neighbourhood_ids: ["rd_a", "rd_b"],
        }),
      ),
    ]);
    expect(await relationshipRows(db, tenant, "rd_source")).toHaveLength(2);

    // The re-judgement found nothing. Nothing of the old set may survive it.
    await writer.replacePublishedSetIf([
      entry(judged(source, { connections: [], connections_neighbourhood_ids: ["rd_a", "rd_b"] })),
    ]);
    expect(await relationshipRows(db, tenant, "rd_source")).toEqual([]);
    expect(await revisionFlags(db, tenant, "rd_source")).toMatchObject({
      connections_present: true,
      connections_computed_at: JUDGED_AT,
      connections_neighbourhood_ids: ["rd_a", "rd_b"],
    });
    // A reading nobody has judged, for contrast: same zero rows, and the flag
    // is what tells the two apart.
    expect(await revisionFlags(db, tenant, "rd_a")).toMatchObject({
      connections_present: false,
      connections_computed_at: null,
    });
  });

  // reading_relationships keys the source only, so the schema accepts a row
  // naming a reading that no longer exists — the dangling inbound row
  // `corpus purge-connections` cleans after a drop. A refresh must not create
  // one, or every pass would need a purge run behind it.
  it("drops a target deleted while the judgement ran, and reports it", async () => {
    const db = sql();
    const tenant = await mintTenant();
    const source = await readyManifest("rd_source");
    await seedManifest(db, tenant, source);
    await seedManifest(db, tenant, await readyManifest("rd_live"));
    await seedManifest(db, tenant, await readyManifest("rd_dropped"));
    await db.execute("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [
      String(tenant.tenantId),
      "rd_dropped",
    ]);

    const outcome = await pgReadingWriterFor(db, tenant).replacePublishedSetIf([
      entry(
        judged(source, {
          connections: [
            { id: "rd_live", reason: "still here" },
            { id: "rd_dropped", reason: "gone" },
          ],
        }),
      ),
    ]);

    expect(outcome).toEqual({
      replaced: true,
      skippedTargets: [{ sourceId: "rd_source", kind: "connection", targetId: "rd_dropped" }],
    });
    expect(await relationshipRows(db, tenant, "rd_source")).toEqual([
      { kind: "connection", target_id: "rd_live" },
    ]);
  });

  describe("a directional pair", () => {
    async function pair(db: Sql, tenant: TenantContext): Promise<[Manifest, Manifest]> {
      const a = await readyManifest("rd_a");
      const b = await readyManifest("rd_b");
      await seedManifest(db, tenant, a);
      await seedManifest(db, tenant, b);
      return [a, b];
    }
    const tension = (id: string, kind: "supersedes" | "superseded_by"): Manifest["tensions"] => [
      { id, kind, reason: "one measured the other's claim", computed_at: JUDGED_AT },
    ];

    it("writes both sides in one transaction", async () => {
      const db = sql();
      const tenant = await mintTenant();
      const [a, b] = await pair(db, tenant);

      const outcome = await pgReadingWriterFor(db, tenant).replacePublishedSetIf([
        entry(judged(a, { tensions: tension("rd_b", "supersedes"), tensions_judged: [{ id: "rd_b", judged_at: JUDGED_AT }] })),
        entry(judged(b, { tensions: tension("rd_a", "superseded_by"), tensions_judged: [{ id: "rd_a", judged_at: JUDGED_AT }] })),
      ]);

      expect(outcome.replaced).toBe(true);
      expect(await relationshipRows(db, tenant, "rd_a")).toEqual([{ kind: "tension", target_id: "rd_b" }]);
      expect(await relationshipRows(db, tenant, "rd_b")).toEqual([{ kind: "tension", target_id: "rd_a" }]);
    });

    // Half a judged pair is not a partial success: it is a corpus where one
    // reading cites a tension the other has never heard of.
    it("writes neither side when one guard has stopped agreeing", async () => {
      const db = sql();
      const tenant = await mintTenant();
      const [a, b] = await pair(db, tenant);

      const outcome = await pgReadingWriterFor(db, tenant).replacePublishedSetIf([
        entry(judged(a, { tensions: tension("rd_b", "supersedes") })),
        entry(judged(b, { tensions: tension("rd_a", "superseded_by") }), () => false),
      ]);

      expect(outcome).toEqual({ replaced: false, skippedTargets: [] });
      expect(await relationshipRows(db, tenant, "rd_a")).toEqual([]);
      expect(await relationshipRows(db, tenant, "rd_b")).toEqual([]);
    });

    // A repair writes one side from the other. The side it read from is a
    // guard: checked under the same locks, never rewritten, so its row keeps a
    // relationship to a reading that is gone, which a rewrite would drop.
    it.each([
      { guardAgrees: true, written: [{ kind: "tension", target_id: "rd_a" }] },
      { guardAgrees: false, written: [] },
    ])("writes the entry only while its guard agrees ($guardAgrees), never rewriting the guard", async ({ guardAgrees, written }) => {
      const db = sql();
      const tenant = await mintTenant();
      const [a, b] = await pair(db, tenant);
      await seedManifest(db, tenant, { ...a, tensions: tension("rd_gone", "supersedes") });

      const outcome = await pgReadingWriterFor(db, tenant).replacePublishedSetIf(
        [entry(judged(b, { tensions: tension("rd_a", "superseded_by") }))],
        [{ id: "rd_a", matches: () => guardAgrees }],
      );

      expect(outcome.replaced).toBe(guardAgrees);
      expect(await relationshipRows(db, tenant, "rd_b")).toEqual(written);
      expect(await relationshipRows(db, tenant, "rd_a")).toEqual([{ kind: "tension", target_id: "rd_gone" }]);
    });

    it("refuses a set that names one reading twice", async () => {
      const db = sql();
      const tenant = await mintTenant();
      const [a] = await pair(db, tenant);
      await expect(
        pgReadingWriterFor(db, tenant).replacePublishedSetIf([entry(judged(a, {})), entry(judged(a, {}))]),
      ).rejects.toThrow("a reading may appear once");
    });
  });
});
