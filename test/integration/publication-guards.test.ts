// Publication guards: the reading writer's contract against real PostgreSQL.
// Publication is one transaction in a fixed order; every writer verb decides
// ownership under the reading's row lock; the missing row is the deletion
// fence; URL ownership and every read are scoped by tenant; and a publish that
// fails rolls back and is retried rather than marked failed, because the
// summary it would publish is already paid for.
//
// Each table row mints its own tenant, so the rows count a tenant's whole
// footprint rather than picking rows out by reading id.

import { env } from "cloudflare:test";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../src/control-plane/ids";
import { dispatchQueueMessage, type Env } from "../../src/index";
import type { Sql } from "../../src/modules/db/sql";
import { reprocessPending, submitPending } from "../../src/modules/manifest-drafting";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { pgReadingStoreFor } from "../../src/modules/stores/postgres/reading-store";
import {
  pgReadingWriterFor,
  PublishCommitError,
  type NewAttempt,
  type PgReadingWriter,
} from "../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../src/modules/stores/postgres/similarity-store";
import { processReading, type ProcessReadingArgs } from "../../src/process-reading";
import type { Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";
import { axisVector, mintTenant, mintTenantWithoutUser, readyManifest, seedManifest, testSql } from "../helpers/pg-fixtures";
import { interceptSql, TENANT_STATUS_LOCK } from "../helpers/sql-faults";
import { founderTenant, reserveReadingSlot } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";
import { clearBucket, makeServices, makeStubFetch } from "./readings-harness";

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
