import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { fromSql } from "../../../src/control-plane/db";
import {
  markRefreshDispatched,
  readRefreshJob,
} from "../../../src/control-plane/relationship-refresh-jobs";
import { insertActiveUser } from "../../helpers/control-plane-db";
import type { TenantContext } from "../../../src/control-plane/ids";
import type { Sql } from "../../../src/modules/db/sql";
import { reprocessPending, submitPending } from "../../../src/modules/manifest-drafting";
import { buildKeyPrefix, r2KeyLayout } from "../../../src/modules/stores/layout";
import { pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import { pgReadingWriterFor, type NewAttempt } from "../../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import type { Manifest, ProcessingAttemptSummary } from "../../../src/schemas/manifest";
import { sha256Hex } from "../../../src/services";
import { axisVector, mintTenant, readyManifest, seedManifest, testSql } from "../../helpers/pg-fixtures";

const CREATED_AT = "2026-04-26T20:00:00.000Z";
const LATER = "2026-04-26T20:05:00.000Z";
const layout = r2KeyLayout("");

const open: Sql[] = [];
function sql(): Sql {
  const s = testSql();
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

async function pendingFor(id: string, url: string, attemptId: string) {
  const identity = { id, url, urlHash: await sha256Hex(url), createdAt: CREATED_AT };
  const draft = submitPending(identity, { attemptId, startedAt: CREATED_AT });
  const attempt: NewAttempt = { summary: draft.attempt, payload: { ...identity, attemptId } };
  return { identity, manifest: draft.manifest, attempt, keyPrefix: buildKeyPrefix(id, CREATED_AT) };
}

function finished(attempt: ProcessingAttemptSummary, status: "succeeded" | "failed"): ProcessingAttemptSummary {
  return { ...attempt, status, finished_at: LATER };
}

function contentFor(keyPrefix: string, attemptId: string) {
  return {
    rawKey: layout.revisionRawKey(keyPrefix, attemptId, "html"),
    extractedKey: layout.revisionExtractedKey(keyPrefix, attemptId),
  };
}

async function readyFrom(pending: Manifest, overrides: Partial<Manifest> = {}): Promise<Manifest> {
  return readyManifest(pending.id, {
    url: pending.url,
    last_attempt: finished(pending.active_attempt!, "succeeded"),
    updated_at: LATER,
    ...overrides,
  });
}

// Claim, then publish: the ordinary way a reading becomes ready.
async function publishNew(s: Sql, tenant: TenantContext, id: string, url: string, embedding = axisVector(1)) {
  const p = await pendingFor(id, url, `at_${id}_1`);
  const writer = pgReadingWriterFor(s, tenant);
  await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
  await writer.publish(
    { id, attemptId: `at_${id}_1`, urlHash: p.identity.urlHash },
    await readyFrom(p.manifest),
    { keyPrefix: p.keyPrefix, content: contentFor(p.keyPrefix, `at_${id}_1`), embedding, claimMissingUrl: true },
  );
  return p;
}

// The reading as intake loads it before deciding on an attempt.
async function loaded(s: Sql, tenant: TenantContext, id: string): Promise<Manifest> {
  return (await pgReadingStoreFor(s, tenant).loadReadingById(id))!.manifest;
}

async function jobState(s: Sql, tenant: TenantContext, id: string, attemptId: string): Promise<string | undefined> {
  const [row] = await s.query<{ state: string }>(
    "SELECT state FROM reading_jobs WHERE tenant_id = $1 AND reading_id = $2 AND attempt_id = $3",
    [String(tenant.tenantId), id, attemptId],
  );
  return row?.state;
}

describe("claimUrl", () => {
  it("commits the reading, its URL, the attempt and a queued job together", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_claim", "https://example.com/claim", "at_1");

    expect(await pgReadingWriterFor(s, tenant).claimUrl(p.manifest, p.keyPrefix, p.attempt)).toEqual({ kind: "claimed" });

    const store = pgReadingStoreFor(s, tenant);
    expect(await store.findOwnerByUrl(p.manifest.url)).toEqual({ id: "rd_claim", status: "pending" });
    expect((await store.loadReadingById("rd_claim"))!.manifest).toEqual(p.manifest);
    expect(await jobState(s, tenant, "rd_claim", "at_1")).toBe("queued");
  });

  it("converges concurrent duplicate submissions on one reading", async () => {
    const tenant = mintTenant();
    const url = "https://example.com/duplicate";
    const a = await pendingFor("rd_dup_a", url, "at_a");
    const b = await pendingFor("rd_dup_b", url, "at_b");

    // Two connections, so the claims really race on the unique key.
    const outcomes = await Promise.all([
      pgReadingWriterFor(sql(), tenant).claimUrl(a.manifest, a.keyPrefix, a.attempt),
      pgReadingWriterFor(sql(), tenant).claimUrl(b.manifest, b.keyPrefix, b.attempt),
    ]);

    const winner = outcomes[0].kind === "claimed" ? "rd_dup_a" : "rd_dup_b";
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["claimed", "owned"]);
    expect(outcomes.find((o) => o.kind === "owned")).toEqual({ kind: "owned", ownerId: winner });
    // The loser left nothing behind: no orphan reading, attempt or job.
    const list = await pgReadingStoreFor(sql(), tenant).listManifests({ offset: 0, limit: 10 });
    expect(list.readings.map((r) => r.id)).toEqual([winner]);
  });

  it("lets two tenants own the same URL", async () => {
    const s = sql();
    const p = await pendingFor("rd_shared", "https://example.com/shared", "at_1");
    expect((await pgReadingWriterFor(s, mintTenant()).claimUrl(p.manifest, p.keyPrefix, p.attempt)).kind).toBe("claimed");
    expect((await pgReadingWriterFor(s, mintTenant()).claimUrl(p.manifest, p.keyPrefix, p.attempt)).kind).toBe("claimed");
  });
});

describe("queue-send failure", () => {
  it("leaves a failed, re-submittable owner and a send_failed job", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_send", "https://example.com/send", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    const failed = finished(p.attempt.summary, "failed");
    const rolledBack: Manifest = {
      ...p.manifest,
      status: "failed",
      content_status: "failed",
      active_attempt: undefined,
      last_attempt: failed,
      error: { code: "QueueSendError", message: "queue down", retryable: true },
    };
    expect(await writer.failActivation({ id: "rd_send", attemptId: "at_1" }, rolledBack, failed, { contentCaptured: true })).toBe(true);

    // Still the URL's owner, so a resubmit reprocesses this reading in place.
    expect(await pgReadingStoreFor(s, tenant).findOwnerByUrl(p.manifest.url)).toEqual({ id: "rd_send", status: "failed" });
    expect(await jobState(s, tenant, "rd_send", "at_1")).toBe("send_failed");
  });

  // A re-import whose content put failed must not leave the reading pointing
  // at objects that never landed: its content stays the previous import's.
  it("drops the keys of content that never reached R2", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_reimport", "https://example.com/reimport", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, { ...p.attempt, content: contentFor(p.keyPrefix, "at_1") });
    const firstFailed = finished(p.attempt.summary, "failed");
    const failedManifest: Manifest = { ...p.manifest, status: "failed", content_status: "failed", active_attempt: undefined, last_attempt: firstFailed };
    await writer.fail({ id: "rd_reimport", attemptId: "at_1" }, failedManifest, { allowLastAttempt: true, now: LATER });

    const seen = await loaded(s, tenant, "rd_reimport");
    const second = { id: "at_2", trigger: "import" as const, status: "running" as const, started_at: LATER };
    const next: Manifest = { ...seen, status: "pending", active_attempt: second };
    await writer.startAttempt(next, { summary: second, payload: {}, content: contentFor(p.keyPrefix, "at_2") }, seen);
    const secondFailed = finished(second, "failed");
    await writer.failActivation({ id: "rd_reimport", attemptId: "at_2" }, { ...next, status: "failed", active_attempt: undefined, last_attempt: secondFailed }, secondFailed, { contentCaptured: false });

    expect(await pgReadingStoreFor(s, tenant).contentKeys("rd_reimport")).toMatchObject(contentFor(p.keyPrefix, "at_1"));
  });

  it("only records the failed attempt on a published reading, keeping a write made since the start", async () => {
    const s = sql();
    const tenant = mintTenant();
    await seedManifest(s, tenant, await readyManifest("rd_judged"), { embedding: axisVector(1) });
    const writer = pgReadingWriterFor(s, tenant);
    const seen = await loaded(s, tenant, "rd_judged");
    const draft = reprocessPending(seen, { attemptId: "at_re", startedAt: LATER }, LATER);
    await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen);
    // The relationship judge rewrites the reading while the send is in flight.
    const judged = { ...(await loaded(s, tenant, "rd_judged")), novelty_verdict: "duplicate" as const };
    expect(await writer.replacePublishedIf("rd_judged", () => true, judged)).toBe(true);

    const failed = finished(draft.attempt, "failed");
    await writer.failActivation({ id: "rd_judged", attemptId: "at_re" }, { ...seen, last_attempt: failed, updated_at: LATER }, failed, { contentCaptured: true });

    expect(await loaded(s, tenant, "rd_judged")).toEqual({ ...judged, active_attempt: undefined, last_attempt: failed, updated_at: LATER });
  });
});

describe("publish", () => {
  it("commits the revision, summary, relationships and embedding together", async () => {
    const s = sql();
    const tenant = mintTenant();
    await publishNew(s, tenant, "rd_target", "https://example.com/target", axisVector(2));
    const p = await pendingFor("rd_pub", "https://example.com/pub", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    const ready = await readyFrom(p.manifest, { connections: [{ id: "rd_target", reason: "same topic" }] });
    const outcome = await writer.publish({ id: "rd_pub", attemptId: "at_1", urlHash: p.identity.urlHash }, ready, {
      keyPrefix: p.keyPrefix,
      content: contentFor(p.keyPrefix, "at_1"),
      embedding: axisVector(1),
      claimMissingUrl: true,
    });

    expect(outcome).toEqual({ committed: true, published: true });
    const store = pgReadingStoreFor(s, tenant);
    expect((await store.loadReadingById("rd_pub"))!.manifest).toEqual(ready);
    expect(await store.contentKeys("rd_pub")).toMatchObject(contentFor(p.keyPrefix, "at_1"));
    const neighbours = await pgSimilarityStoreFor(s, tenant).query(axisVector(1), 5);
    expect(neighbours[0]!.id).toBe("rd_pub");
    expect(await jobState(s, tenant, "rd_pub", "at_1")).toBe("done");
  });

  // The ordering contract: ownership is settled under the lock before anything
  // is written, so an attempt that lost the reading changes no row at all.
  it("writes nothing when another attempt owns the reading", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_lost", "https://example.com/lost", "at_owner");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    const stale = { id: "rd_lost", attemptId: "at_stale", urlHash: p.identity.urlHash };
    const outcome = await writer.publish(stale, await readyFrom(p.manifest), {
      keyPrefix: p.keyPrefix,
      content: contentFor(p.keyPrefix, "at_stale"),
      embedding: axisVector(1),
      claimMissingUrl: true,
    });

    expect(outcome).toEqual({ committed: false, published: false });
    const store = pgReadingStoreFor(s, tenant);
    expect((await store.loadReadingById("rd_lost"))!.manifest).toEqual(p.manifest);
    expect(await pgSimilarityStoreFor(s, tenant).queryByVectorId("rd_lost", 5)).toBeNull();
    expect(await s.query("SELECT 1 FROM reading_revisions WHERE tenant_id = $1", [String(tenant.tenantId)])).toEqual([]);
  });

  it("rolls the whole publication back when one part fails", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_atomic", "https://example.com/atomic", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    // The embedding is the last write; a wrong dimension fails it.
    await expect(
      writer.publish({ id: "rd_atomic", attemptId: "at_1", urlHash: p.identity.urlHash }, await readyFrom(p.manifest), {
        keyPrefix: p.keyPrefix,
        content: contentFor(p.keyPrefix, "at_1"),
        embedding: [1, 2, 3],
        claimMissingUrl: true,
      }),
    ).rejects.toThrow(/1536/);

    // Still pending and still owned by the attempt, so a queue retry republishes.
    expect((await pgReadingStoreFor(s, tenant).loadReadingById("rd_atomic"))!.manifest).toEqual(p.manifest);
    expect(await s.query("SELECT 1 FROM reading_revisions WHERE tenant_id = $1", [String(tenant.tenantId)])).toEqual([]);
  });

  it("stores a duplicate that does not own its URL without making it searchable", async () => {
    const s = sql();
    const tenant = mintTenant();
    const owner = await publishNew(s, tenant, "rd_owner", "https://example.com/owned");
    // An imported orphan: same URL, no URL row of its own.
    const orphan = await readyManifest("rd_orphan", {
      url: owner.manifest.url,
      status: "pending",
      active_attempt: { id: "at_o", trigger: "reprocess", status: "running", started_at: CREATED_AT },
    });
    await seedManifest(s, tenant, orphan, { ownsUrl: false });

    const outcome = await pgReadingWriterFor(s, tenant).publish(
      { id: "rd_orphan", attemptId: "at_o", urlHash: owner.identity.urlHash },
      await readyFrom(orphan),
      { keyPrefix: owner.keyPrefix, content: contentFor(owner.keyPrefix, "at_o"), embedding: axisVector(3), claimMissingUrl: true },
    );

    expect(outcome).toEqual({ committed: true, published: false });
    expect(await pgSimilarityStoreFor(s, tenant).queryByVectorId("rd_orphan", 5)).toBeNull();
    expect(await pgReadingStoreFor(s, tenant).findOwnerByUrl(owner.manifest.url)).toMatchObject({ id: "rd_owner" });
  });
});

describe("reprocessing", () => {
  // Seeded the way the importer writes a reading: content at the legacy keys.
  async function importedReady(s: Sql, tenant: TenantContext, id: string) {
    const manifest = await readyManifest(id);
    const keyPrefix = await seedManifest(s, tenant, manifest, { embedding: axisVector(1) });
    return { manifest, keyPrefix };
  }

  it("keeps the published content and summary together when the reprocess fails", async () => {
    const s = sql();
    const tenant = mintTenant();
    const { manifest, keyPrefix } = await importedReady(s, tenant, "rd_keep");
    const store = pgReadingStoreFor(s, tenant);
    const keysBefore = await store.contentKeys("rd_keep");
    const writer = pgReadingWriterFor(s, tenant);

    const draft = reprocessPending(manifest, { attemptId: "at_re", startedAt: LATER }, LATER);
    const started = await writer.startAttempt(
      draft.manifest,
      { summary: draft.attempt, payload: {}, content: contentFor(keyPrefix, "at_re") },
      await loaded(s, tenant, "rd_keep"),
    );
    expect(started).toEqual({ kind: "started" });

    const failed = finished(draft.attempt, "failed");
    const failedManifest: Manifest = { ...draft.manifest, status: "failed", active_attempt: undefined, last_attempt: failed };
    const outcome = await writer.fail({ id: "rd_keep", attemptId: "at_re" }, failedManifest, { allowLastAttempt: true, now: LATER });

    expect(outcome.committed).toBe(true);
    const after = (await store.loadReadingById("rd_keep"))!.manifest;
    expect(after).toEqual({ ...manifest, last_attempt: failed, updated_at: LATER });
    expect(await store.contentKeys("rd_keep")).toEqual(keysBefore);
    expect((await pgSimilarityStoreFor(s, tenant).queryByVectorId("rd_keep", 5))).not.toBeNull();
  });

  it("moves an imported reading onto its new revision keys when the reprocess succeeds", async () => {
    const s = sql();
    const tenant = mintTenant();
    const { manifest, keyPrefix } = await importedReady(s, tenant, "rd_move");
    const writer = pgReadingWriterFor(s, tenant);
    const draft = reprocessPending(manifest, { attemptId: "at_re", startedAt: LATER }, LATER);
    await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, await loaded(s, tenant, "rd_move"));

    const ready = await readyFrom(draft.manifest, { source_type: "markdown", content_type: "text/markdown; charset=utf-8" });
    await writer.publish({ id: "rd_move", attemptId: "at_re", urlHash: manifest.url_hash }, ready, {
      keyPrefix,
      content: { rawKey: layout.revisionRawKey(keyPrefix, "at_re", "md"), extractedKey: layout.revisionExtractedKey(keyPrefix, "at_re") },
      embedding: axisVector(2),
      claimMissingUrl: false,
    });

    const store = pgReadingStoreFor(s, tenant);
    expect((await store.loadReadingById("rd_move"))!.manifest.source_type).toBe("markdown");
    expect((await store.contentKeys("rd_move"))!.rawKey).toBe(`${keyPrefix}/revisions/at_re/raw.md`);
  });

  it("refuses to start when another attempt activated since the caller looked", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_busy", "https://example.com/busy", "at_running");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    const draft = reprocessPending(p.manifest, { attemptId: "at_second", startedAt: LATER }, LATER);
    // The caller decided on a snapshot with no active attempt.
    const seen = { ...(await loaded(s, tenant, "rd_busy")), active_attempt: undefined };
    expect(await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen)).toEqual({ kind: "conflict" });
    expect((await pgReadingStoreFor(s, tenant).loadReadingById("rd_busy"))!.manifest.active_attempt!.id).toBe("at_running");
  });

  // `next` replaces every mutable column, so starting from a stale read would
  // undo whatever landed in between.
  it("refuses to start when another writer changed the reading since the caller looked", async () => {
    const s = sql();
    const tenant = mintTenant();
    const { manifest } = await importedReady(s, tenant, "rd_stale");
    const writer = pgReadingWriterFor(s, tenant);
    const seen = await loaded(s, tenant, "rd_stale");
    expect(await writer.replacePublishedIf("rd_stale", () => true, { ...seen, novelty_verdict: "familiar" })).toBe(true);

    const draft = reprocessPending(manifest, { attemptId: "at_re", startedAt: LATER }, LATER);
    const started = await writer.startAttempt(draft.manifest, { summary: draft.attempt, payload: {} }, seen);

    expect(started).toEqual({ kind: "changed" });
    expect(await loaded(s, tenant, "rd_stale")).toEqual({ ...seen, novelty_verdict: "familiar" });
  });

  it("re-activates under the same attempt id without failing, keeping a paid checkpoint", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_again", "https://example.com/again", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
    const ref = { id: "rd_again", attemptId: "at_1" };
    await writer.writeCheckpoint(ref, { embed_source: { tokens: 3 } });
    const failed = finished(p.attempt.summary, "failed");
    await writer.failActivation(ref, { ...p.manifest, status: "failed", content_status: "failed", active_attempt: undefined, last_attempt: failed }, failed, { contentCaptured: true });

    // The caller could not confirm its activation and tries again, same id.
    const started = await writer.startAttempt(p.manifest, p.attempt, await loaded(s, tenant, "rd_again"));

    expect(started).toEqual({ kind: "started" });
    expect(await jobState(s, tenant, "rd_again", "at_1")).toBe("queued");
    expect(await writer.readCheckpoint(ref)).toEqual({ embed_source: { tokens: 3 } });
    expect((await writer.listAttempts("rd_again"))[0]).toMatchObject({ id: "at_1", status: "running" });
  });

  it("fails a reading that was never published", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_fail", "https://example.com/fail", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    const failed = finished(p.attempt.summary, "failed");
    const failedManifest: Manifest = {
      ...p.manifest,
      status: "failed",
      content_status: "failed",
      active_attempt: undefined,
      last_attempt: failed,
      error: { code: "FetchError", message: "boom" },
    };
    await writer.fail({ id: "rd_fail", attemptId: "at_1" }, failedManifest, { allowLastAttempt: true, now: LATER, jobState: "dead" });

    expect((await pgReadingStoreFor(s, tenant).loadReadingById("rd_fail"))!.manifest).toEqual(failedManifest);
    expect(await jobState(s, tenant, "rd_fail", "at_1")).toBe("dead");
  });
});

describe("purge", () => {
  const never = () => false;

  it("removes every row and releases the URL", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await publishNew(s, tenant, "rd_gone", "https://example.com/gone");

    const outcome = await pgReadingWriterFor(s, tenant).purge("rd_gone", never);

    expect(outcome).toEqual({ kind: "purged", keyPrefix: p.keyPrefix, urlReleased: true, embeddingRemoved: true });
    const store = pgReadingStoreFor(s, tenant);
    expect(await store.loadReadingById("rd_gone")).toBeNull();
    expect(await store.findOwnerByUrl(p.manifest.url)).toBeNull();
    for (const table of ["reading_revisions", "reading_embeddings", "reading_attempts", "reading_jobs"]) {
      expect(await s.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [String(tenant.tenantId)])).toEqual([]);
    }
  });

  // The refresh checkpoint has no foreign key to hang off, so the purge
  // transaction deletes it by hand: the reading and the hosted work queued
  // about it go at the same instant.
  it("takes the hosted refresh checkpoint with the reading", async () => {
    const s = sql();
    const tenant = mintTenant();
    await insertActiveUser(env, String(tenant.tenantId));
    await publishNew(s, tenant, "rd_chkpt", "https://example.com/checkpoint");
    expect(
      await markRefreshDispatched(fromSql(s), {
        tenantId: String(tenant.tenantId),
        readingId: "rd_chkpt",
        runAt: LATER,
        owner: "at_chkpt",
        sourceEtag: "etag-1",
      }),
    ).toBe(true);

    await pgReadingWriterFor(s, tenant).purge("rd_chkpt", never);

    expect(await readRefreshJob(fromSql(s), String(tenant.tenantId), "rd_chkpt")).toBeNull();
  });

  it("refuses while the caller's staleness rule says an attempt is running", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_running", "https://example.com/running", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);

    expect(await writer.purge("rd_running", (row) => row.active_attempt?.status === "running")).toEqual({ kind: "conflict" });
    expect(await writer.purge("rd_missing", never)).toEqual({ kind: "not_found" });
  });

  // The deletion fence: a consumer that was mid-flight when the purge landed
  // cannot republish the reading, or recreate any row for it.
  it("stops a late consumer from republishing", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_race", "https://example.com/race", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
    await writer.purge("rd_race", never);

    const ref = { id: "rd_race", attemptId: "at_1", urlHash: p.identity.urlHash };
    const late = await writer.publish(ref, await readyFrom(p.manifest), {
      keyPrefix: p.keyPrefix,
      content: contentFor(p.keyPrefix, "at_1"),
      embedding: axisVector(1),
      claimMissingUrl: true,
    });

    expect(late).toEqual({ committed: false, published: false });
    expect(await writer.fail(ref, p.manifest, { allowLastAttempt: true, now: LATER })).toEqual({ committed: false, published: false });
    expect(
      await writer.recordAttempt({
        ...p.attempt.summary,
        reading_id: "rd_race",
        url: p.manifest.url,
        url_hash: p.identity.urlHash,
        key_prefix: p.keyPrefix,
        events: [],
      }),
    ).toBe(false);
    const store = pgReadingStoreFor(s, tenant);
    expect(await store.loadReadingById("rd_race")).toBeNull();
    expect(await store.findOwnerByUrl(p.manifest.url)).toBeNull();
  });
});

// Slice 1c.3: `users` is in this database, so the verbs that create rows read
// the tenant's status under a FOR SHARE lock inside their own transaction.
// claimUrl's refusal is owned by the account-deletion race test; this covers
// the other verb that activates an attempt.
describe("tenant eligibility", () => {
  it("refuses to start an attempt for a tenant that is no longer active", async () => {
    const s = sql();
    const tenant = mintTenant();
    await insertActiveUser(env, String(tenant.tenantId));
    const { manifest } = await (async () => {
      const m = await readyManifest("rd_inelig");
      await seedManifest(s, tenant, m, { embedding: axisVector(1) });
      return { manifest: m };
    })();
    await fromSql(s).run("UPDATE users SET status = 'deleting' WHERE id = ?", String(tenant.tenantId));
    const writer = pgReadingWriterFor(s, tenant);
    const draft = reprocessPending(manifest, { attemptId: "at_re", startedAt: LATER }, LATER);

    const started = await writer.startAttempt(
      draft.manifest,
      { summary: draft.attempt, payload: {} },
      await loaded(s, tenant, "rd_inelig"),
    );

    expect(started).toEqual({ kind: "tenant_inactive" });
    // Nothing was activated: the reading still stands as it was published.
    expect((await pgReadingStoreFor(s, tenant).loadReadingById("rd_inelig"))!.manifest).toEqual(manifest);
    expect(
      await s.query("SELECT 1 FROM reading_attempts WHERE tenant_id = $1 AND id = $2", [String(tenant.tenantId), "at_re"]),
    ).toEqual([]);
  });
});

describe("attempt log", () => {
  it("records events and a paid checkpoint against the attempt", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_log", "https://example.com/log", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
    const ref = { id: "rd_log", attemptId: "at_1" };

    const attempt = {
      ...p.attempt.summary,
      stage: "embed_source" as const,
      reading_id: "rd_log",
      url: p.manifest.url,
      url_hash: p.identity.urlHash,
      key_prefix: p.keyPrefix,
      events: [{ stage: "embed_source" as const, status: "started" as const, at: LATER }],
    };
    expect(await writer.recordAttempt(attempt)).toBe(true);
    await writer.writeCheckpoint(ref, { embed_source: { tokens: 3 } });

    expect(await writer.listAttempts("rd_log")).toEqual([attempt]);
    expect(await writer.readCheckpoint(ref)).toEqual({ embed_source: { tokens: 3 } });
    expect(await writer.readCheckpoint({ id: "rd_log", attemptId: "at_other" })).toBeNull();
  });
});

describe("content of a reading that was never published", () => {
  it("is found under the latest attempt that captured any", async () => {
    const s = sql();
    const tenant = mintTenant();
    const p = await pendingFor("rd_raw", "https://example.com/raw", "at_1");
    const writer = pgReadingWriterFor(s, tenant);
    await writer.claimUrl(p.manifest, p.keyPrefix, p.attempt);
    const store = pgReadingStoreFor(s, tenant);
    // Nothing captured yet: the legacy spelling, as for an imported reading.
    expect((await store.contentKeys("rd_raw"))!.rawKey).toBe(`${p.keyPrefix}/raw.bin`);

    await writer.setAttemptContent({ id: "rd_raw", attemptId: "at_1" }, contentFor(p.keyPrefix, "at_1"));

    expect(await store.contentKeys("rd_raw")).toMatchObject(contentFor(p.keyPrefix, "at_1"));
  });
});

describe("deleteAllReadings", () => {
  it("removes one tenant's readings and leaves the other's", async () => {
    const s = sql();
    const gone = mintTenant();
    const kept = mintTenant();
    await publishNew(s, gone, "rd_a", "https://example.com/a");
    await publishNew(s, kept, "rd_a", "https://example.com/a");

    expect(await pgReadingWriterFor(s, gone).deleteAllReadings()).toBe(1);

    expect(await pgReadingStoreFor(s, gone).loadReadingById("rd_a")).toBeNull();
    expect(await pgReadingStoreFor(s, kept).loadReadingById("rd_a")).not.toBeNull();
  });
});
