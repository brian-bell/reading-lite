// Publication guards: the reading writer's contract against real PostgreSQL.
// Publication is one transaction in a fixed order; every writer verb decides
// ownership under the reading's row lock; the missing row is the deletion
// fence; URL ownership and every read are scoped by tenant; and a publish that
// fails rolls back and is retried rather than marked failed, because the
// summary it would publish is already paid for.
//
// Each table row mints its own tenant, so the rows count a tenant's whole
// footprint rather than picking rows out by reading id.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArchiveExport } from "../../src/archive-export";
import { archiveExportEnvelopeV1 } from "../../src/control-plane/export-envelope";
import type { TenantContext } from "../../src/control-plane/ids";
import { dispatchQueueMessage, type Env } from "../../src/index";
import type { Sql } from "../../src/modules/db/sql";
import { reprocessPending, submitPending } from "../../src/modules/manifest-drafting";
import { contentStoreFor } from "../../src/modules/stores/content-store";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { pgDeskStoreFor } from "../../src/modules/stores/postgres/desk-store";
import { pgReadingStoreFor } from "../../src/modules/stores/postgres/reading-store";
import {
  pgReadingWriterFor,
  PublishCommitError,
  type NewAttempt,
  type PgReadingWriter,
} from "../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../src/modules/stores/postgres/similarity-store";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import { createApp } from "../../src/router";
import type { Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";
import { axisVector, mintTenant, mintTenantWithoutUser, readyManifest, seedManifest, testSql } from "../helpers/pg-fixtures";
import { interceptSql, TENANT_STATUS_LOCK } from "../helpers/sql-faults";
import { founderTenant, reserveReadingSlot } from "../helpers/tenant-fixtures";
import { readZipEntries } from "../helpers/read-zip";
import { testReadingsFor } from "../helpers/test-readings";
import { clearBucket, makeServices, makeStubFetch, TOKEN } from "./readings-harness";

const CREATED_AT = "2026-04-26T20:00:00.000Z";
const LATER = "2026-04-26T20:05:00.000Z";
const layout = r2KeyLayout("");

const open: Sql[] = [];
function sql(): Sql {
  const s = testSql();
  open.push(s);
  return s;
}
beforeEach(clearBucket);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function pendingFor(id: string, url: string, attemptId: string) {
  const identity = { id, url, urlHash: await sha256Hex(url), createdAt: CREATED_AT };
  const draft = submitPending(identity, { attemptId, startedAt: CREATED_AT });
  const attempt: NewAttempt = { summary: draft.attempt, payload: { ...identity, attemptId } };
  return { manifest: draft.manifest, attempt, keyPrefix: buildKeyPrefix(id, CREATED_AT) };
}

// A pending reading claimed the way intake claims it.
async function claimed(writer: PgReadingWriter, id: string, attemptId = "at_1") {
  const p = await pendingFor(id, `https://example.com/${id}`, attemptId);
  await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
  return p;
}

async function readyFrom(pending: Manifest, overrides: Partial<Manifest> = {}): Promise<Manifest> {
  return readyManifest(pending.id, {
    url: pending.url,
    last_attempt: { ...pending.active_attempt!, status: "succeeded", finished_at: LATER },
    updated_at: LATER,
    ...overrides,
  });
}

// Publish `pending` as `attemptId`: an embedding and one connection, so every
// write in the transaction runs. The target need not exist; the relationship
// foreign key covers the source only.
async function publishAs(writer: PgReadingWriter, pending: Manifest, attemptId: string, embedding = axisVector(1)) {
  const keyPrefix = buildKeyPrefix(pending.id, CREATED_AT);
  return writer.publish(
    { id: pending.id, attemptId, urlHash: pending.url_hash },
    await readyFrom(pending, { connections: [{ id: "rd_elsewhere", reason: "same topic" }] }),
    {
      keyPrefix,
      content: { rawKey: layout.revisionRawKey(keyPrefix, attemptId, "html"), extractedKey: layout.revisionExtractedKey(keyPrefix, attemptId) },
      embedding,
      claimMissingUrl: true,
    },
  );
}

// Start a reprocess attempt on a published reading, as intake does.
async function reprocess(s: Sql, tenant: TenantContext, id: string, attemptId: string) {
  const seen = (await pgReadingStoreFor(s, tenant).loadReadingById(id))!;
  const draft = reprocessPending(seen.manifest, { attemptId, startedAt: LATER }, LATER);
  await pgReadingWriterFor(s, tenant).startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen);
  return { seen, draft };
}

const TABLES = [
  "readings", "reading_urls", "reading_revisions", "reading_relationships",
  "reading_embeddings", "reading_attempts", "reading_jobs",
] as const;
type Footprint = Record<(typeof TABLES)[number], number>;
const EMPTY: Footprint = Object.fromEntries(TABLES.map((table) => [table, 0])) as Footprint;
const CLAIMED: Footprint = { ...EMPTY, readings: 1, reading_urls: 1, reading_attempts: 1, reading_jobs: 1 };

async function footprint(s: Sql, tenant: TenantContext): Promise<Footprint> {
  const counts = await Promise.all(
    TABLES.map(async (table) => {
      const [row] = await s.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = $1`, [String(tenant.tenantId)]);
      return [table, row!.n] as const;
    }),
  );
  return Object.fromEntries(counts) as Footprint;
}

async function standing(s: Sql, tenant: TenantContext, id: string) {
  const m = (await pgReadingStoreFor(s, tenant).loadReadingById(id))?.manifest;
  return m ? { status: m.status, activeAttempt: m.active_attempt?.id ?? null, error: m.error ?? null } : null;
}

const NOTHING_PUBLISHED = { committed: false, published: false, superseded: null };

describe("reading writer", () => {
  // Statements are labelled by the first step they match; a statement matching
  // none (the superseded revision's key lookup) is not a step. Consecutive
  // statements of one step collapse, so a step written twice out of place
  // still shows up as a second entry.
  const STEPS: [string, RegExp][] = [
    ["begin", /^BEGIN/],
    ["tenant lock", TENANT_STATUS_LOCK],
    ["reading lock", /FROM readings WHERE tenant_id = \$1 AND id = \$2\s+FOR UPDATE/],
    ["URL ownership", /reading_urls/],
    ["revision", /^INSERT INTO reading_revisions/],
    ["reading", /^UPDATE readings SET/],
    ["superseded revision", /^DELETE FROM reading_revisions/],
    ["relationships", /reading_relationships/],
    ["embedding", /reading_embeddings/],
    ["attempt", /reading_attempts/],
    ["job", /reading_jobs/],
    ["commit", /^COMMIT/],
  ];

  it("publish commits in the contract order", async () => {
    const s = sql();
    const tenant = await mintTenant();
    const writer = pgReadingWriterFor(s, tenant);
    const p = await claimed(writer, "rd_order");
    await publishAs(writer, p.manifest, "at_1");
    const { draft } = await reprocess(s, tenant, "rd_order", "at_2");

    const statements: string[] = [];
    const query = pg.Client.prototype.query as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push((typeof first === "string" ? first : first?.text ?? "").trim());
      return query.apply(this, args);
    } as never);
    // Replaces at_1's revision, so the superseded-revision delete runs too.
    const outcome = await publishAs(writer, draft.manifest, "at_2", axisVector(2));
    vi.restoreAllMocks();

    expect(outcome, "committed and searchable, handing back at_1's keys").toMatchObject({
      committed: true,
      published: true,
      superseded: { rawKey: expect.stringContaining("/revisions/at_1/") },
    });
    const sequence = statements
      .map((text) => STEPS.find(([, pattern]) => pattern.test(text))?.[0])
      .filter((step): step is string => step !== undefined)
      .filter((step, i, all) => step !== all[i - 1]);
    expect(sequence, "publish statement order").toEqual(STEPS.map(([step]) => step));
  });

  // Each row arranges its own tenant, acts, and returns what it observed.
  const rows: { name: string; observe: () => Promise<unknown>; expected: unknown }[] = [
    {
      // Ownership is settled under the lock before anything is written.
      name: "an attempt that lost the reading writes nothing",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const writer = pgReadingWriterFor(s, tenant);
        const p = await claimed(writer, "rd_lost", "at_owner");
        const outcome = await publishAs(writer, p.manifest, "at_stale");
        return { outcome, reading: await standing(s, tenant, "rd_lost"), rows: await footprint(s, tenant) };
      },
      expected: {
        outcome: NOTHING_PUBLISHED,
        reading: { status: "pending", activeAttempt: "at_owner", error: null },
        rows: CLAIMED,
      },
    },
    {
      // The embedding is the last write, so the revision, reading and
      // relationships were already written when it fails: the rollback is real.
      // The attempt still owns the reading, which is what lets a retry publish.
      name: "a publish that fails part-way rolls back whole",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const writer = pgReadingWriterFor(s, tenant);
        const p = await claimed(writer, "rd_atomic");
        const fault = interceptSql(/^INSERT INTO reading_embeddings/, () => new Error("database unavailable"));
        const outcome = await publishAs(writer, p.manifest, "at_1").then(
          () => "committed",
          (error: unknown) => (error instanceof PublishCommitError ? "PublishCommitError" : error),
        );
        fault.mockRestore();
        return { outcome, reading: await standing(s, tenant, "rd_atomic"), rows: await footprint(s, tenant) };
      },
      expected: {
        outcome: "PublishCommitError",
        reading: { status: "pending", activeAttempt: "at_1", error: null },
        rows: CLAIMED,
      },
    },
    {
      // A consumer mid-flight on a reprocess when the purge lands: no verb may
      // republish the reading or recreate any row for it, since the row's
      // absence is the only fence.
      name: "a purged reading leaves no row and takes no late write",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const writer = pgReadingWriterFor(s, tenant);
        const p = await claimed(writer, "rd_fence");
        await publishAs(writer, p.manifest, "at_1");
        const { seen, draft } = await reprocess(s, tenant, "rd_fence", "at_2");
        const before = await footprint(s, tenant);
        const purge = await writer.purge("rd_fence", () => false);

        const ref = { id: "rd_fence", attemptId: "at_2" };
        const failed = { ...draft.attempt, status: "failed" as const, finished_at: LATER };
        const failedManifest = { ...draft.manifest, status: "failed" as const, active_attempt: undefined, last_attempt: failed };
        const late = {
          publish: await publishAs(writer, draft.manifest, "at_2"),
          fail: await writer.fail(ref, failedManifest, { allowLastAttempt: true, now: LATER }),
          failActivation: await writer.failActivation(ref, failedManifest, failed),
          startAttempt: (await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen)).kind,
          recordAttempt: await writer.recordAttempt({
            ...draft.attempt, reading_id: "rd_fence", url: p.manifest.url, url_hash: p.manifest.url_hash,
            key_prefix: p.keyPrefix, events: [],
          }),
        };
        return {
          before,
          purge,
          late,
          reading: await standing(s, tenant, "rd_fence"),
          urlOwner: await pgReadingStoreFor(s, tenant).findOwnerByUrl(p.manifest.url),
          rows: await footprint(s, tenant),
        };
      },
      expected: {
        before: {
          readings: 1, reading_urls: 1, reading_revisions: 1, reading_relationships: 1,
          reading_embeddings: 1, reading_attempts: 2, reading_jobs: 2,
        },
        purge: { kind: "purged", keyPrefix: buildKeyPrefix("rd_fence", CREATED_AT), urlReleased: true, embeddingRemoved: true },
        late: {
          publish: NOTHING_PUBLISHED,
          fail: { committed: false, published: false },
          failActivation: false,
          startAttempt: "not_found",
          recordAttempt: false,
        },
        reading: null,
        urlOwner: null,
        rows: EMPTY,
      },
    },
    {
      // Two connections, so the claims really race on the unique key. The
      // loser leaves nothing behind; another tenant's claim is independent.
      name: "duplicate claims converge on one owner per tenant",
      observe: async () => {
        const tenant = await mintTenant();
        const other = await mintTenant();
        const url = "https://example.com/duplicate";
        const a = await pendingFor("rd_dup_a", url, "at_a");
        const b = await pendingFor("rd_dup_b", url, "at_b");
        const outcomes = await Promise.all([
          pgReadingWriterFor(sql(), tenant).claimUrl(a.manifest, a.keyPrefix, a.attempt),
          pgReadingWriterFor(sql(), tenant).claimUrl(b.manifest, b.keyPrefix, b.attempt),
        ]);
        const winner = outcomes[0].kind === "claimed" ? "rd_dup_a" : "rd_dup_b";
        const s = sql();
        return {
          kinds: outcomes.map((o) => o.kind).sort(),
          loserSeesWinner: outcomes.some((o) => o.kind === "owned" && o.ownerId === winner),
          otherTenant: await pgReadingWriterFor(s, other).claimUrl(a.manifest, a.keyPrefix, a.attempt),
          rows: await footprint(s, tenant),
          otherRows: await footprint(s, other),
        };
      },
      expected: {
        kinds: ["claimed", "owned"],
        loserSeesWinner: true,
        otherTenant: { kind: "claimed" },
        rows: CLAIMED,
        otherRows: CLAIMED,
      },
    },
    {
      // An imported orphan: same URL, no URL row of its own. Stored, because
      // the attempt paid for it, but only the URL's owner is searchable.
      name: "a duplicate that does not own its URL publishes without a vector",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const writer = pgReadingWriterFor(s, tenant);
        const owner = await claimed(writer, "rd_owner");
        await publishAs(writer, owner.manifest, "at_1");
        const orphan = await readyManifest("rd_orphan", {
          url: owner.manifest.url,
          status: "pending",
          active_attempt: { id: "at_o", trigger: "reprocess", status: "running", started_at: CREATED_AT },
        });
        await seedManifest(s, tenant, orphan, { ownsUrl: false });
        return {
          outcome: await publishAs(writer, orphan, "at_o", axisVector(3)),
          orphanVector: await pgSimilarityStoreFor(s, tenant).queryByVectorId("rd_orphan", 5),
          urlOwner: (await pgReadingStoreFor(s, tenant).findOwnerByUrl(owner.manifest.url))?.id,
        };
      },
      expected: { outcome: { committed: true, published: false, superseded: null }, orphanVector: null, urlOwner: "rd_owner" },
    },
    {
      // Teardown deletes `users` last. A claim that authenticated before that
      // must not write rows no wipe would ever come back for.
      name: "a tenant without a user row claims nothing",
      observe: async () => {
        const s = sql();
        const tenant = mintTenantWithoutUser();
        const p = await pendingFor("rd_torndown", "https://example.com/torn-down", "at_1");
        return { outcome: await pgReadingWriterFor(s, tenant).claimUrl(p.manifest, p.keyPrefix, p.attempt), rows: await footprint(s, tenant) };
      },
      expected: { outcome: { kind: "tenant_inactive" }, rows: EMPTY },
    },
    {
      // The owner's vector sits closer to the query than the stranger's own,
      // so a scan that dropped the tenant filter would rank it first.
      name: "every store read is scoped to its tenant",
      observe: async () => {
        const s = sql();
        const owner = await mintTenant();
        const strangerTenant = await mintTenant();
        const url = "https://example.com/private";
        await seedManifest(s, owner, await readyManifest("rd_private", { url }), { embedding: axisVector(1, 0.9) });
        await seedManifest(s, strangerTenant, await readyManifest("rd_mine"), { embedding: axisVector(2, 0.1) });
        const stranger = pgReadingStoreFor(s, strangerTenant);
        const ids = (matches: { id: string }[] | null) => matches?.map((match) => match.id) ?? null;
        return {
          list: (await stranger.listManifests({ offset: 0, limit: 10 })).readings.map((item) => item.id),
          load: await stranger.loadReadingById("rd_private"),
          targets: await stranger.relationshipTargets(["rd_private"]),
          graph: (await stranger.relationshipGraph()).readings.map((item) => item.id),
          urlOwner: await stranger.findOwnerByUrl(url),
          contentKeys: await stranger.contentKeys("rd_private"),
          strangerNearest: ids(await pgSimilarityStoreFor(s, strangerTenant).query(axisVector(0), 5)),
          strangerByOwnerVector: await pgSimilarityStoreFor(s, strangerTenant).queryByVectorId("rd_private", 5),
          ownerNearest: ids(await pgSimilarityStoreFor(s, owner).query(axisVector(0), 5)),
        };
      },
      expected: {
        list: ["rd_mine"],
        load: null,
        targets: [],
        graph: ["rd_mine"],
        urlOwner: null,
        contentKeys: null,
        strangerNearest: ["rd_mine"],
        strangerByOwnerVector: null,
        ownerNearest: ["rd_private"],
      },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))("%s", async (name, { observe, expected }) => {
    expect(await observe(), name).toEqual(expected);
  });
});

describe("the desk", () => {
  // Ready readings, plus a pending one named `rd_pending` when asked for.
  async function deskOf(s: Sql, tenant: TenantContext, ids: string[], pending = false) {
    for (const id of ids) await seedManifest(s, tenant, await readyManifest(id));
    if (pending) await seedManifest(s, tenant, await readyManifest("rd_pending", { status: "pending" }));
    return pgDeskStoreFor(s, tenant, { now: () => LATER });
  }

  // Positions as both reads report them: every list row, and the detail's.
  async function positions(s: Sql, tenant: TenantContext) {
    const store = pgReadingStoreFor(s, tenant);
    const rows = (await store.listManifests({ offset: 0, limit: 10 })).readings;
    const listed = Object.fromEntries(rows.filter((row) => row.desk_position).map((row) => [row.id, row.desk_position]));
    const loaded: Record<string, number> = {};
    for (const row of rows) {
      const position = (await store.loadReadingById(row.id))?.deskPosition;
      if (position !== undefined) loaded[row.id] = position;
    }
    expect(loaded, "detail positions agree with the list").toEqual(listed);
    return listed;
  }

  const rows: { name: string; observe: () => Promise<unknown>; expected: unknown }[] = [
    {
      // A reading already there is left where it is, whatever its status;
      // a new one must be ready, and the fourth is refused.
      name: "holds three ready readings, adds idempotently, and renumbers on removal",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const desk = await deskOf(s, tenant, ["rd_a", "rd_b", "rd_c", "rd_d"], true);
        const steps = [
          await desk.add("rd_a"),
          await desk.add("rd_b"),
          await desk.add("rd_c"),
          await desk.add("rd_a"),
          await desk.add("rd_d"),
          await desk.add("rd_pending"),
          await desk.add("rd_unknown"),
          await desk.remove("rd_b"),
          await desk.remove("rd_d"),
          await desk.remove("rd_unknown"),
        ];
        return { steps, positions: await positions(s, tenant) };
      },
      expected: {
        steps: [
          { kind: "desk", desk: ["rd_a"] },
          { kind: "desk", desk: ["rd_a", "rd_b"] },
          { kind: "desk", desk: ["rd_a", "rd_b", "rd_c"] },
          { kind: "desk", desk: ["rd_a", "rd_b", "rd_c"] },
          { kind: "desk_full" },
          { kind: "not_ready" },
          { kind: "not_found" },
          { kind: "desk", desk: ["rd_a", "rd_c"] },
          { kind: "desk", desk: ["rd_a", "rd_c"] },
          { kind: "not_found" },
        ],
        positions: { rd_a: 1, rd_c: 2 },
      },
    },
    {
      // The purge cascades the row away with no desk code of its own, and the
      // next write closes the gap it left.
      name: "a purge frees its slot and the next write renumbers",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const desk = await deskOf(s, tenant, ["rd_a", "rd_b", "rd_c", "rd_d"]);
        for (const id of ["rd_a", "rd_b", "rd_c"]) await desk.add(id);
        await pgReadingWriterFor(s, tenant).purge("rd_a", () => false);
        const afterPurge = await positions(s, tenant);
        return { afterPurge, add: await desk.add("rd_d"), afterAdd: await positions(s, tenant) };
      },
      expected: {
        afterPurge: { rd_b: 2, rd_c: 3 },
        add: { kind: "desk", desk: ["rd_b", "rd_c", "rd_d"] },
        afterAdd: { rd_b: 1, rd_c: 2, rd_d: 3 },
      },
    },
    {
      // Two connections, so the adds really race. Without the advisory lock
      // both count two and both take position 3, and one commit fails.
      name: "two adds racing for the last slot: one lands and one is refused",
      observe: async () => {
        const tenant = await mintTenant();
        const desk = await deskOf(sql(), tenant, ["rd_a", "rd_b", "rd_c", "rd_d"]);
        await desk.add("rd_a");
        await desk.add("rd_b");
        const raced = await Promise.all(
          ["rd_c", "rd_d"].map((id) => pgDeskStoreFor(sql(), tenant, { now: () => LATER }).add(id)),
        );
        return { kinds: raced.map((out) => out.kind).sort(), count: Object.keys(await positions(sql(), tenant)).length };
      },
      expected: { kinds: ["desk", "desk_full"], count: 3 },
    },
    {
      // startAttempt compares the row's xmin as its version, and the judges
      // hash the loaded manifest as theirs: a toggle must change neither, and
      // a reprocess and its publish must leave the desk alone.
      name: "a toggle leaves the reading's version alone, and a reprocess and its publish leave the desk alone",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        const writer = pgReadingWriterFor(s, tenant);
        const p = await claimed(writer, "rd_desk");
        await publishAs(writer, p.manifest, "at_1");
        const store = pgReadingStoreFor(s, tenant);
        const seen = (await store.loadReadingById("rd_desk"))!;
        await pgDeskStoreFor(s, tenant, { now: () => LATER }).add("rd_desk");
        const toggled = (await store.loadReadingById("rd_desk"))!;
        const draft = reprocessPending(seen.manifest, { attemptId: "at_2", startedAt: LATER }, LATER);
        const started = await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen);

        const statements: string[] = [];
        const query = pg.Client.prototype.query as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
          const first = args[0] as string | { text?: string };
          statements.push(typeof first === "string" ? first : first?.text ?? "");
          return query.apply(this, args);
        } as never);
        const published = await publishAs(writer, draft.manifest, "at_2", axisVector(2));
        vi.restoreAllMocks();
        return {
          versionUnchanged: toggled.version === seen.version,
          updatedAtUnchanged: toggled.manifest.updated_at === seen.manifest.updated_at,
          manifestCarriesDesk: "desk_position" in toggled.manifest,
          deskPosition: toggled.deskPosition,
          started: started.kind,
          published: published.published,
          publishTouchedDesk: statements.some((text) => text.includes("reading_desk")),
          after: await positions(s, tenant),
        };
      },
      expected: {
        versionUnchanged: true,
        updatedAtUnchanged: true,
        manifestCarriesDesk: false,
        deskPosition: 1,
        started: "started",
        published: true,
        publishTouchedDesk: false,
        after: { rd_desk: 1 },
      },
    },
    {
      name: "the archive carries desk_position in a reading's manifest.json and its index.json item",
      observe: async () => {
        const s = sql();
        const tenant = await mintTenant();
        await (await deskOf(s, tenant, ["rd_on", "rd_off"])).add("rd_on");
        const exportId = "exp_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
        await s.execute(
          `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at) VALUES ($1, $2, 'queued', $3, $3)`,
          [exportId, String(tenant.tenantId), LATER],
        );
        const envelope = archiveExportEnvelopeV1({ tenantId: tenant.tenantId, exportId });
        let outcome = "continue";
        for (let delivery = 0; outcome === "continue" && delivery < 10; delivery++) {
          outcome = await buildArchiveExport(s, envelope, env, { nowMs: Date.parse(LATER) });
        }
        const [row] = await s.query<{ segments: { parts: { key: string }[] } }>(
          "SELECT segments FROM archive_exports WHERE id = $1",
          [exportId],
        );
        const content = contentStoreFor(env.READINGS_BUCKET, tenant, env);
        const parts = await Promise.all(
          row!.segments.parts.map(async (part) => new Uint8Array(await (await content.get(part.key))!.arrayBuffer())),
        );
        const zip = await readZipEntries(new Uint8Array(parts.flatMap((part) => [...part])));
        const json = (name: string) => JSON.parse(new TextDecoder().decode(zip.get(name)!));
        const index = json("index.json") as { items: { id: string; desk_position?: number }[] };
        return {
          outcome,
          manifests: ["rd_on", "rd_off"].map((id) => json(`readings/${id}/manifest.json`).desk_position ?? null),
          index: Object.fromEntries(index.items.map((item) => [item.id, item.desk_position ?? null])),
        };
      },
      expected: { outcome: "ready", manifests: [1, null], index: { rd_on: 1, rd_off: null } },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))("%s", async (name, { observe, expected }) => {
    expect(await observe(), name).toEqual(expected);
  });
});

async function api(path: string, init: { method?: string; json?: unknown } = {}) {
  const ctx = createExecutionContext();
  const res = await createApp({ services: makeServices(makeStubFetch()) }).fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the desk read", () => {
  // The request clock is CREATED_AT (20:00) and the test TTL 300 s, so the
  // staleness cutoff is 19:55. `since` is 18:00.
  const at = (time: string) => `2026-04-26T${time}:00.000Z`;
  const SINCE = at("18:00");
  const failedError = { code: "fetch_failed", message: "fetch failed" };
  const attempt = (trigger: "submit" | "import" | "reprocess", started: string, rest: Record<string, unknown> = {}) => ({
    id: `at_${trigger}_${started}`,
    trigger,
    status: "running" as const,
    started_at: at(started),
    ...rest,
  });
  const ids = (rows: unknown) => (rows as { id: string }[]).map((row) => row.id);
  const pad = (i: number) => String(i).padStart(2, "0");

  async function seedCorpus() {
    const s = sql();
    const tenant = founderTenant();
    const seed = async (id: string, created: string, overrides: Partial<Manifest> = {}) =>
      seedManifest(s, tenant, await readyManifest(id, { created_at: at(created), updated_at: at(created), ...overrides }));
    for (let i = 0; i < 25; i++) await seed(`rd_f${pad(i)}`, `10:${pad(i)}`, { status: "failed", error: failedError });
    await seed("rd_reprocess_failed", "19:30", {
      last_attempt: { ...attempt("reprocess", "19:40"), status: "failed", finished_at: at("19:41"), error: failedError },
    });
    // Expired attempts: a ready reading's reprocess fails it as a reprocess;
    // a pending reading's fails the reading.
    await seed("rd_reprocess_expired", "19:31", { active_attempt: attempt("reprocess", "19:00") });
    await seed("rd_pending_expired", "19:01", { status: "pending", active_attempt: attempt("submit", "19:01") });
    await seed("rd_stale_pending", "19:00", { status: "pending" });
    // Batch-owned pending is exempt from staleness.
    await seed("rd_batch", "08:00", {
      status: "pending",
      active_attempt: attempt("import", "08:00", { id: "batch_1", stage: "summarize" }),
    });
    await seed("rd_pending", "19:58", { status: "pending", active_attempt: attempt("submit", "19:58") });
    for (let i = 0; i <= 10; i++) await seed(`rd_r${pad(i)}`, `18:${pad(i + 1)}`);
    // A live reprocess leaves a ready reading ready.
    await seed("rd_live_reprocess", "18:30", { active_attempt: attempt("reprocess", "19:59") });
    await seed("rd_at_since", "18:00");
    await seed("rd_old", "17:00");
    for (const [position, id] of [[1, "rd_r00"], [2, "rd_f00"]] as const) {
      await s.execute(
        "INSERT INTO reading_desk (tenant_id, reading_id, position, added_at) VALUES ($1, $2, $3, $4)",
        [String(tenant.tenantId), id, position, CREATED_AT],
      );
    }
  }

  it("groups after staleness, bounds each group, counts what it left out, and needs since for ready_since", async () => {
    await seedCorpus();
    const { status, body } = await api(`/api/desk?since=${SINCE}`);
    expect(status).toBe(200);
    const byId = new Map(
      [...(body.on_desk as never[]), ...(body.needs_you as never[]), ...(body.processing as never[]), ...(body.ready_since as never[])]
        .map((row: { id: string }) => [row.id, row as Record<string, unknown>]),
    );
    expect({
      on_desk: ids(body.on_desk),
      desk_positions: (body.on_desk as { desk_position: number }[]).map((row) => row.desk_position),
      needs_you: ids(body.needs_you),
      needs_you_total: body.needs_you_total,
      processing: ids(body.processing),
      processing_total: body.processing_total,
      ready_since: ids(body.ready_since),
      ready_since_total: body.ready_since_total,
    }).toEqual({
      on_desk: ["rd_r00", "rd_f00"],
      desk_positions: [1, 2],
      needs_you: [
        "rd_reprocess_expired", "rd_reprocess_failed", "rd_pending_expired", "rd_stale_pending",
        ...Array.from({ length: 16 }, (_, i) => `rd_f${pad(24 - i)}`),
      ],
      needs_you_total: 29,
      processing: ["rd_pending", "rd_batch"],
      processing_total: 2,
      // A failed reprocess leaves the reading ready, so it is also new here.
      ready_since: [
        "rd_reprocess_expired", "rd_reprocess_failed", "rd_live_reprocess",
        ...Array.from({ length: 7 }, (_, i) => `rd_r${pad(10 - i)}`),
      ],
      ready_since_total: 13,
    });
    expect(
      Object.fromEntries(
        ["rd_reprocess_expired", "rd_pending_expired", "rd_stale_pending", "rd_f00"].map((id) => {
          const row = byId.get(id)! as { status: string; error?: { code: string }; last_attempt?: { status: string; error?: { code: string } } };
          return [id, [row.status, row.error?.code ?? null, row.last_attempt?.error?.code ?? null]];
        }),
      ),
      "rows carry the staleness the grouping decided over",
    ).toEqual({
      rd_reprocess_expired: ["ready", null, "stale_active_attempt"],
      rd_pending_expired: ["failed", "stale_active_attempt", "stale_active_attempt"],
      rd_stale_pending: ["failed", "stale_pending", null],
      rd_f00: ["failed", "fetch_failed", null],
    });

    const unsince = await api("/api/desk");
    expect(
      { status: unsince.status, ready_since: unsince.body.ready_since, total: unsince.body.ready_since_total },
      "no since lists nothing as ready since",
    ).toEqual({ status: 200, ready_since: [], total: 0 });
    expect((await api("/api/desk?since=yesterday")).status, "a since that is not a datetime").toBe(400);
  });
});

describe("the relationships read", () => {
  const get = async (path: string, init: { method?: string; json?: unknown } = {}) => (await api(path, init)).body;

  // rd_source connects to a live reading and to one that was purged, and has a
  // tension with a failed one. A ready reading with no rows still appears; a
  // pending one with none does not, and an expired pending end reads failed.
  it("lists every ready reading and each live row's ends, and counts only live targets", async () => {
    const s = sql();
    const tenant = founderTenant();
    const OLD = "2026-01-01T00:00:00.000Z";
    await seedManifest(s, tenant, await readyManifest("rd_target", { created_at: OLD, updated_at: OLD }));
    await seedManifest(s, tenant, await readyManifest("rd_failed", { status: "failed", error: { code: "fetch_failed", message: "fetch failed" } }));
    await seedManifest(s, tenant, await readyManifest("rd_stuck", { status: "pending", created_at: OLD, updated_at: OLD }));
    await seedManifest(s, tenant, await readyManifest("rd_waiting", { status: "pending", created_at: OLD, updated_at: OLD }));
    await seedManifest(s, tenant, await readyManifest("rd_alone"));
    await seedManifest(s, tenant, await readyManifest("rd_source", {
      connections: [
        { id: "rd_target", reason: "same ground" },
        { id: "rd_purged", reason: "gone now" },
        { id: "rd_stuck", reason: "still pending" },
      ],
      tensions: [{ id: "rd_failed", kind: "contradicts", reason: "disagrees", computed_at: CREATED_AT }],
    }));

    const graph = (await get("/api/readings/relationships")) as {
      readings: { id: string; status: string; created_at: string }[];
      relationships: unknown[];
    };
    expect(graph.readings.map((r) => [r.id, r.status])).toEqual([
      ["rd_alone", "ready"],
      ["rd_failed", "failed"],
      ["rd_source", "ready"],
      ["rd_stuck", "failed"],
      ["rd_target", "ready"],
    ]);
    expect(graph.relationships).toEqual([
      { source_id: "rd_source", kind: "connection", target_id: "rd_target", reason: "same ground" },
      { source_id: "rd_source", kind: "connection", target_id: "rd_stuck", reason: "still pending" },
      { source_id: "rd_source", kind: "tension", target_id: "rd_failed", tension_kind: "contradicts", reason: "disagrees" },
    ]);

    const listed = (await get("/api/readings")).readings as { id: string; connection_count?: number; tension_count?: number }[];
    const counts = Object.fromEntries(listed.map((r) => [r.id, [r.connection_count, r.tension_count]]));
    expect(counts.rd_source, "rd_purged is not counted").toEqual([2, 1]);
    expect(counts.rd_alone).toEqual([0, 0]);

    const detail = (await get("/api/readings/rd_source")).relationship_targets as Record<string, { created_at: string }>;
    expect(detail.rd_target?.created_at).toBe(OLD);
    const mcp = await get("/mcp", {
      method: "POST",
      json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_reading", arguments: { id: "rd_source" } } },
    });
    const tool = JSON.parse((mcp.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;
    expect(tool.id).toBe("rd_source");
    expect(tool, "MCP strips the web UI's target map").not.toHaveProperty("relationship_targets");
  });
});

describe("the queue consumer", () => {
  // By publish time the summary is paid for and checkpointed. A failed publish
  // therefore leaves the reading pending under its attempt and asks the queue
  // for a retry: acking would strand it, and marking it failed would throw the
  // summary away. The redelivery has to actually publish, and re-use the
  // checkpointed summary instead of paying for another.
  it("a failed publish rolls back and requeues, and the retry republishes without paying twice", async () => {
    const id = "rd_RETRY";
    const url = "https://example.com/publish-retry";
    const readings = testReadingsFor(founderTenant());
    const job: ProcessReadingArgs = {
      id,
      url,
      urlHash: await sha256Hex(url),
      createdAt: CREATED_AT,
      keyPrefix: buildKeyPrefix(id, CREATED_AT),
      attemptId: "at_RETRY",
      attemptStartedAt: CREATED_AT,
      trigger: "submit",
      email: false,
    };
    // What intake leaves for the consumer: a pending reading this job's
    // attempt owns, and a reserved reading slot.
    await readings.seed(
      {
        id, url, url_hash: job.urlHash, status: "pending", content_type: "application/octet-stream",
        content_status: "captured", content_bytes: 0, content_sha256: "0".repeat(64),
        created_at: CREATED_AT, updated_at: CREATED_AT,
        active_attempt: { id: job.attemptId!, trigger: "submit", status: "running", started_at: CREATED_AT },
      },
      { keyPrefix: job.keyPrefix },
    );
    await reserveReadingSlot(env, founderTenant(), job);
    const fetchFn = makeStubFetch();
    const services = makeServices(fetchFn);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The first delivery's publish fails at its last write; later ones pass.
    interceptSql(/^INSERT INTO reading_embeddings/, (call) => (call === 1 ? new Error("database unavailable") : "pass"));

    const deliver = async (attempts: number) => {
      const msg = { body: {}, ack: vi.fn(), retry: vi.fn(), attempts };
      await dispatchQueueMessage(msg as unknown as Message<unknown>, () =>
        processReading(job, env as unknown as Env, services, founderTenant()),
      );
      const manifest = await readings.manifest(id);
      return {
        acked: msg.ack.mock.calls.length,
        retried: msg.retry.mock.calls.length,
        status: manifest?.status,
        activeAttempt: manifest?.active_attempt?.id ?? null,
        error: manifest?.error ?? null,
        searchable: await readings.hasEmbedding(id),
      };
    };

    expect(await deliver(1), "first delivery: publish failed").toEqual({
      acked: 0, retried: 1, status: "pending", activeAttempt: job.attemptId, error: null, searchable: false,
    });
    expect(await deliver(2), "redelivery").toEqual({
      acked: 1, retried: 0, status: "ready", activeAttempt: null, error: null, searchable: true,
    });
    const summarizes = fetchFn.mock.calls.filter(([input]) => String(input).startsWith("https://api.openai.com/v1/responses"));
    expect(summarizes, "summarizer calls across both deliveries").toHaveLength(1);
  });
});
