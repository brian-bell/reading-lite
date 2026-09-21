// PostgreSQL write store for readings (ADR 0005). Every verb is one
// transaction that locks the reading row first, so ownership is decided and
// acted on atomically. That lock replaces the etag CAS on manifest.json, the
// index/list.json CAS loop, the by-url pointer CAS, the purge tombstone and the
// ledger-before-manifest ordering.
//
// Tenant eligibility joins those transactions (slice 1c.3). `users` lives in
// this database, so a verb that creates or publishes rows locks the tenant's
// user row FOR SHARE and reads `status` under that lock. `DELETE /api/account`
// updates the same row, so it waits behind an in-flight claim or publish and
// every later one sees `deleting`: the before/after eligibility checks the
// consumer used to make around publish, and the compensation for the window
// between them, are gone. Where both locks are taken the order is tenant row,
// then reading row. The verbs that only act on a reading that already exists
// take no tenant lock; a verb that CREATES a row needs it.
//
// The deletion fence is the row itself. A purged reading has no row, the lock
// finds nothing, and the verb reports that nothing was committed. Child rows
// cannot be recreated either: their foreign keys need the reading.
//
// Never hold one of these transactions across a provider fetch or an R2 write.
// Content goes to R2 under the attempt's revision keys first; the row that
// points at it commits afterwards.

import { attemptOwnership, resolveAttemptId, type AttemptRef } from "../../../attempt-ownership";
import type { TenantContext } from "../../../control-plane/ids";
import {
  ProcessingAttemptSchema,
  type Manifest,
  type ProcessingAttempt,
  type ProcessingAttemptSummary,
} from "../../../schemas/manifest";
import type { Sql, SqlQuery } from "../../db/sql";
import {
  insertReading,
  insertRelationships,
  insertRevision,
  json,
  manifestToRows,
  upsertEmbedding,
  type ReadingRow,
} from "./manifest-rows";
import { PgReadingStore, pgTenantId } from "./reading-store";

export function pgReadingWriterFor(sql: Sql, tenant: TenantContext): PgReadingWriter {
  return new PgReadingWriter(sql, pgTenantId(tenant));
}

export type { AttemptRef };

// The relative R2 keys an attempt captured its content under.
export interface AttemptContentKeys {
  rawKey: string;
  extractedKey: string | null;
}

export interface NewAttempt {
  summary: ProcessingAttemptSummary;
  // The queue message body, kept as durable job intent.
  payload: unknown;
  // Present when the content is captured before processing (markdown import).
  content?: AttemptContentKeys;
}

export type ClaimOutcome =
  | { kind: "claimed" }
  | { kind: "owned"; ownerId: string | null }
  // The tenant stopped being active between admission and this transaction.
  | { kind: "tenant_inactive" };

export type StartAttemptOutcome =
  | { kind: "started" }
  | { kind: "not_found" }
  | { kind: "tenant_inactive" }
  // The reading's active attempt is not the one the caller decided on.
  | { kind: "conflict" }
  // Same active attempt, but another writer (the relationship judge) changed
  // the reading since the caller read it. The caller re-reads and decides again.
  | { kind: "changed" };

export interface CommitOutcome {
  // The terminal state was written by this attempt.
  committed: boolean;
  // The reading is searchable: it owns its URL and its embedding was stored.
  published: boolean;
}

// One reading's half of a relationship replace: the manifest to write and the
// guard that decides, under the row lock, whether it still should be.
export interface PublishedReplacement {
  id: string;
  matches: (current: Manifest) => boolean | Promise<boolean>;
  next: Manifest;
}

// A relationship the replace dropped because its target reading no longer
// exists. The pass reports these; nothing is written for them.
export interface SkippedTarget {
  sourceId: string;
  kind: "connection" | "tension";
  targetId: string;
}

export interface ReplaceSetOutcome {
  // Every entry was written, or none was.
  replaced: boolean;
  skippedTargets: SkippedTarget[];
}

export type PurgeOutcome =
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "purged"; keyPrefix: string; urlReleased: boolean; embeddingRemoved: boolean };

type OwnershipRow = Pick<Manifest, "status" | "active_attempt" | "last_attempt">;

export type PurgeGuardRow = OwnershipRow & Pick<Manifest, "created_at" | "updated_at">;

interface LockedRow extends OwnershipRow {
  [column: string]: unknown;
  key_prefix: string;
  url_hash: string;
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
}

// The publish transaction failed and rolled back: nothing was committed, so
// the attempt still owns the reading and an ordinary queue retry republishes
// for real. The consumer requeues on this instead of marking the reading
// failed, because by publish time the summarization is paid for and
// checkpointed and the retry re-uses it. (This is the contract the vector
// ledger's fail-closed write used to carry.)
export class PublishCommitError extends Error {
  constructor(public readonly cause: unknown) {
    super(`publish transaction failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PublishCommitError";
  }
}

// Thrown inside claimUrl's transaction to roll back the reading it inserted.
class UrlAlreadyOwned extends Error {}

// Thrown inside claimUrl's transaction when the tenant lock shows the account
// is no longer active: nothing it inserted survives the rollback.
class TenantInactive extends Error {}

const FOREIGN_KEY_VIOLATION = "23503";

// The columns a terminal or pending write replaces. key_prefix is fixed at
// creation, and current_revision_id moves only when a revision is published.
const MUTABLE_COLUMNS = [
  "status", "source_type", "title", "tldr", "tags", "keywords", "people", "orgs",
  "novelty_verdict", "source_date", "fetched_at", "updated_at", "content_type",
  "content_status", "content_bytes", "extracted_bytes", "content_sha256", "error",
  "similarity", "enrichment_degradation", "active_attempt", "last_attempt",
] as const satisfies readonly (keyof ReadingRow)[];
const JSONB_COLUMNS = new Set<string>(["error", "similarity", "enrichment_degradation", "active_attempt", "last_attempt"]);

export class PgReadingWriter {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
  ) {}

  // Eager, tenant-scoped URL ownership. The reading, its URL row, the attempt
  // and the job commit together or not at all, so there is no "initializing"
  // owner. A concurrent claim of the same URL waits on the unique key and then
  // sees the winner, so duplicate submissions converge on one reading.
  //
  // Eligibility is decided under the tenant lock, before any insert: a claim
  // that raced `DELETE /api/account` leaves no reading, no URL row, no attempt
  // and no job behind.
  async claimUrl(pending: Manifest, keyPrefix: string, attempt: NewAttempt): Promise<ClaimOutcome> {
    const rows = manifestToRows(pending, { tenantId: this.tenantId, keyPrefix, ownsUrl: true });
    try {
      await this.sql.transaction(async (tx) => {
        if (!(await this.tenantIsActive(tx))) throw new TenantInactive();
        await insertReading(tx, rows.reading);
        const claimed = await tx.query(
          `INSERT INTO reading_urls (tenant_id, url_hash, reading_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, url_hash) DO NOTHING RETURNING reading_id`,
          [this.tenantId, pending.url_hash, pending.id],
        );
        if (claimed.length === 0) throw new UrlAlreadyOwned();
        await this.insertAttempt(tx, pending.id, attempt);
      });
      return { kind: "claimed" };
    } catch (error) {
      if (error instanceof TenantInactive) return { kind: "tenant_inactive" };
      if (!(error instanceof UrlAlreadyOwned)) throw error;
    }
    const [owner] = await this.sql.query<{ reading_id: string }>(
      "SELECT reading_id FROM reading_urls WHERE tenant_id = $1 AND url_hash = $2",
      [this.tenantId, pending.url_hash],
    );
    // Null when the owner was purged between the conflict and this read. The
    // caller re-resolves either way, and its next claim finds the URL free.
    return { kind: "owned", ownerId: owner?.reading_id ?? null };
  }

  // A new attempt on an existing reading: reprocess, or a failed owner taken
  // up again in place. `seen` is the reading as the caller loaded it and built
  // `next` from. `next` replaces every mutable column, so it may only land on
  // that exact reading: if another attempt activated since, this one yields,
  // and if anything else changed, the caller must rebuild `next`.
  async startAttempt(next: Manifest, attempt: NewAttempt, seen: Manifest): Promise<StartAttemptOutcome> {
    return this.sql.transaction(async (tx) => {
      if (!(await this.tenantIsActive(tx))) return { kind: "tenant_inactive" };
      const row = await this.lock(tx, next.id);
      if (!row) return { kind: "not_found" };
      if (row.active_attempt?.id !== seen.active_attempt?.id) return { kind: "conflict" };
      const current = await new PgReadingStore(tx, this.tenantId).loadReadingById(next.id);
      if (!current || JSON.stringify(current.manifest) !== JSON.stringify(seen)) return { kind: "changed" };
      await this.updateReading(tx, next);
      await this.insertAttempt(tx, next.id, attempt);
      return { kind: "started" };
    });
  }

  async markJobSent(ref: AttemptRef): Promise<void> {
    await this.setJobState(this.sql, ref.id, resolveAttemptId(ref), "sent");
  }

  // The queue send failed after the attempt committed. `rolledBack` is the
  // reading as it should stand without this attempt. The job row stays, marked
  // send_failed, as the record that the work was asked for and never queued.
  //
  // A published reading only records the failed attempt, as `fail` does:
  // `rolledBack` was built before this lock, and the relationship judge may
  // have rewritten the reading since. `contentCaptured` is false when the
  // attempt's import content never reached R2; its keys are then cleared, so
  // the reading's content resolves to an earlier attempt's instead.
  async failActivation(
    ref: AttemptRef,
    rolledBack: Manifest,
    failed: ProcessingAttemptSummary,
    opts: { contentCaptured: boolean },
  ): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, ref.id);
      if (!row || !attemptOwnership(row, ref).isActive) return false;
      if (isPublished(row)) {
        await this.recordFailedAttempt(tx, ref.id, failed, rolledBack.updated_at);
      } else {
        await this.updateReading(tx, rolledBack);
      }
      await this.finishAttempt(tx, ref.id, failed, "send_failed");
      if (!opts.contentCaptured) {
        await tx.query(
          `UPDATE reading_attempts SET raw_key = NULL, extracted_key = NULL
           WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
          [this.tenantId, ref.id, failed.id],
        );
      }
      return true;
    });
  }

  // Publication. Ownership is verified under the row lock, then the revision,
  // the reading, its relationships and its embedding commit in one
  // transaction: a reader never sees a summary without its content keys, or a
  // searchable vector for a reading that is not ready.
  //
  // The order inside the transaction is the contract: tenant lock, reading
  // lock, ownership, URL ownership, revision, reading, relationships,
  // embedding, attempt. Nothing is written before ownership is settled.
  //
  // The tenant lock is what makes the reading searchable or not: an ineligible
  // tenant's reading is still stored — the attempt paid for it — but keeps no
  // embedding, and a deletion that arrives during this transaction waits for
  // it and then sweeps the row with the rest of the account.
  async publish(
    ref: AttemptRef & { urlHash: string },
    ready: Manifest,
    opts: { keyPrefix: string; content: AttemptContentKeys; embedding: readonly number[] | null; claimMissingUrl: boolean },
  ): Promise<CommitOutcome> {
    if (ready.status !== "ready") throw new Error("publish: manifest is not ready");
    const attemptId = resolveAttemptId(ref);
    return this.sql.transaction(async (tx) => {
      const tenantActive = await this.tenantIsActive(tx);
      const row = await this.lock(tx, ref.id);
      if (!row) return { committed: false, published: false };
      const owner = attemptOwnership(row, ref);
      if (!owner.isActive && !owner.isLegacyPending) return { committed: false, published: false };
      const ownsUrl = await this.resolveUrlOwnership(tx, ref, opts.claimMissingUrl);

      const rows = manifestToRows(ready, {
        tenantId: this.tenantId,
        keyPrefix: opts.keyPrefix,
        ownsUrl,
        revision: { id: attemptId, rawKey: opts.content.rawKey, extractedKey: opts.content.extractedKey },
      });
      await insertRevision(tx, this.tenantId, ref.id, rows.revision!);
      await this.updateReading(tx, ready, attemptId);
      await tx.query("DELETE FROM reading_relationships WHERE tenant_id = $1 AND source_id = $2", [this.tenantId, ref.id]);
      await insertRelationships(tx, this.tenantId, ref.id, rows.relationships);
      // Only the URL's owner is searchable, and only for an active tenant. A
      // duplicate that does not own its URL is stored but keeps no vector, as
      // it kept none in Vectorize.
      const searchable = tenantActive && ownsUrl && opts.embedding !== null;
      if (searchable) {
        await upsertEmbedding(tx, this.tenantId, ref.id, opts.embedding!);
      } else {
        await this.deleteEmbedding(tx, ref.id);
      }
      if (ready.last_attempt) await this.finishAttempt(tx, ref.id, ready.last_attempt, "done");
      return { committed: true, published: searchable } satisfies CommitOutcome;
    }).catch((cause: unknown) => {
      // The transaction rolled back. See PublishCommitError.
      throw new PublishCommitError(cause);
    });
  }

  // The failure terminal. A reading with a published revision keeps it: the
  // attempt wrote its content under its own keys, so the previous content and
  // summary are still intact together, and only the attempt summaries change.
  // Otherwise the reading becomes `failed`, as the supplied manifest says.
  async fail(
    ref: AttemptRef,
    failed: Manifest,
    opts: { allowLastAttempt: boolean; now: string; jobState?: "done" | "dead" },
  ): Promise<CommitOutcome> {
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, ref.id);
      if (!row) return { committed: false, published: false };
      const owner = attemptOwnership(row, ref);
      if (!owner.isActive && !owner.isLegacyPending && !(opts.allowLastAttempt && owner.isLast)) {
        return { committed: false, published: false };
      }
      if (isPublished(row)) {
        await this.recordFailedAttempt(tx, ref.id, failed.last_attempt, opts.now);
      } else {
        await this.updateReading(tx, failed);
        await this.deleteEmbedding(tx, ref.id);
      }
      if (failed.last_attempt) await this.finishAttempt(tx, ref.id, failed.last_attempt, opts.jobState ?? "done");
      return { committed: true, published: false };
    });
  }

  // Compare-and-replace on a published reading, for the relationship judge:
  // it rewrites relationship fields and the novelty verdict long after the
  // attempt that published them, so attempt ownership does not apply. `matches`
  // sees the reading as it stands under the row lock, which is what the etag
  // CAS on manifest.json gave it. Content keys and the embedding are untouched.
  //
  // One entry of the set below, written that way so the codebase has one lock
  // order rather than two.
  async replacePublishedIf(
    id: string,
    matches: (current: Manifest) => boolean | Promise<boolean>,
    next: Manifest,
  ): Promise<boolean> {
    const outcome = await this.replacePublishedSetIf([{ id, matches, next }]);
    return outcome.replaced;
  }

  // Several published readings replaced in ONE transaction, all or none.
  //
  // A directional tension is judged once and belongs on both readings
  // (`a contradicts b` and `b superseded_by a`). Written as two separate
  // replaces that is two transactions: a crash between them leaves half a pair
  // on the corpus, and two passes judging the overlapping pairs (a,b) and
  // (b,a) at once take each other's rows in opposite orders and deadlock. So
  // the pair is one call: every reading it names is locked up front, in sorted
  // id order, before any of them is read.
  //
  // `matches` still decides per entry, and a single `false` abandons the whole
  // set: half a judged pair is not a partial success, it is a corpus that
  // disagrees with itself.
  async replacePublishedSetIf(entries: readonly PublishedReplacement[]): Promise<ReplaceSetOutcome> {
    for (const entry of entries) {
      if (entry.next.status !== "ready") throw new Error("replacePublishedSetIf: manifest is not ready");
    }
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      // Two entries for one reading would have the second silently discard the
      // first's relationship rows, which is never what a caller means.
      throw new Error("replacePublishedSetIf: a reading may appear once");
    }
    if (entries.length === 0) return { replaced: false, skippedTargets: [] };

    return this.sql.transaction(async (tx) => {
      const abandoned: ReplaceSetOutcome = { replaced: false, skippedTargets: [] };
      const locked = new Map<string, LockedRow>();
      // Sorted, so two passes that overlap on a pair queue behind each other
      // instead of each holding the row the other needs next.
      for (const id of [...ids].sort()) {
        const row = await this.lock(tx, id);
        if (!row || row.status !== "ready" || row.current_revision_id === null) return abandoned;
        locked.set(id, row);
      }

      const store = new PgReadingStore(tx, this.tenantId);
      const current = new Map<string, Manifest>();
      for (const entry of entries) {
        const reading = await store.loadReadingById(entry.id);
        if (!reading) return abandoned;
        current.set(entry.id, reading.manifest);
      }
      // Every guard runs before any write: a set is abandoned whole, and a
      // guard never sees a sibling's half-written state.
      for (const entry of entries) {
        if (!(await entry.matches(current.get(entry.id)!))) return abandoned;
      }

      const skippedTargets: SkippedTarget[] = [];
      for (const entry of entries) {
        const row = locked.get(entry.id)!;
        const rows = manifestToRows(entry.next, {
          tenantId: this.tenantId,
          keyPrefix: row.key_prefix,
          ownsUrl: false,
        });
        const v = rows.revision!;
        const live = await this.liveReadings(tx, rows.relationships.map((rel) => rel.target_id));
        const kept = rows.relationships.filter((rel) => {
          if (live.has(rel.target_id)) return true;
          skippedTargets.push({ sourceId: entry.id, kind: rel.kind, targetId: rel.target_id });
          return false;
        });
        await this.updateReading(tx, entry.next);
        await tx.query(
          `UPDATE reading_revisions SET summary_markdown = $4, usage = $5::jsonb, connections_present = $6,
             tensions_present = $7, connections_computed_at = $8, connections_neighbourhood_ids = $9,
             tensions_judged = $10::jsonb
           WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
          [
            this.tenantId, entry.id, row.current_revision_id, v.summary_markdown, json(v.usage), v.connections_present,
            v.tensions_present, v.connections_computed_at, v.connections_neighbourhood_ids, json(v.tensions_judged),
          ],
        );
        await tx.query(
          "DELETE FROM reading_relationships WHERE tenant_id = $1 AND source_id = $2",
          [this.tenantId, entry.id],
        );
        await insertRelationships(tx, this.tenantId, entry.id, kept);
      }
      return { replaced: true, skippedTargets };
    });
  }

  // Which of these readings still exist, read inside the replace's
  // transaction. `reading_relationships` has a foreign key on the source only,
  // so a row naming a deleted target is accepted by the schema and becomes the
  // dangling inbound row `corpus purge-connections` cleans up after a drop. A
  // judgement that raced a delete is the one way a refresh can produce one, so
  // the targets are resolved at the last moment, under the same lock as the
  // write, and the missing ones are dropped and reported rather than stored.
  private async liveReadings(tx: SqlQuery, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx.query<{ id: string }>(
      "SELECT id FROM readings WHERE tenant_id = $1 AND id = ANY($2::text[])",
      [this.tenantId, [...new Set(ids)]],
    );
    return new Set(rows.map((row) => row.id));
  }

  // Reading purge. `isRunning` is the caller's staleness rule, evaluated under
  // the lock so a purge and an activation cannot both win. Deleting the row
  // cascades to the URL, revisions, relationships, embedding, attempts and
  // jobs, and is the fence that stops a late consumer from republishing. The
  // caller deletes the R2 prefix afterwards.
  //
  // The hosted refresh checkpoint has no foreign key to the reading (it is a
  // control-plane row keyed by tenant and reading), so it is deleted here, in
  // the same transaction: the reading and the work queued about it disappear
  // together, and no later refresh delivery finds a checkpoint for a reading
  // that is gone.
  async purge(id: string, isRunning: (row: PurgeGuardRow) => boolean): Promise<PurgeOutcome> {
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) return { kind: "not_found" };
      if (isRunning(row)) return { kind: "conflict" };
      const url = await tx.query(
        "SELECT 1 FROM reading_urls WHERE tenant_id = $1 AND reading_id = $2",
        [this.tenantId, id],
      );
      const embeddingRemoved = await this.deleteEmbedding(tx, id);
      await tx.query(
        "DELETE FROM relationship_refresh_jobs WHERE tenant_id = $1 AND reading_id = $2",
        [this.tenantId, id],
      );
      await tx.query("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [this.tenantId, id]);
      return { kind: "purged", keyPrefix: row.key_prefix, urlReleased: url.length > 0, embeddingRemoved };
    });
  }

  // The attempt log. Returns false when the reading is gone: a purged reading
  // must not get an attempt recreated, and the foreign key refuses it.
  async recordAttempt(attempt: ProcessingAttempt): Promise<boolean> {
    try {
      await this.sql.query(
        `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, stage, started_at, finished_at, error, events)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
         ON CONFLICT (tenant_id, reading_id, id) DO UPDATE SET
           status = EXCLUDED.status, stage = EXCLUDED.stage, finished_at = EXCLUDED.finished_at,
           error = EXCLUDED.error, events = EXCLUDED.events`,
        [
          this.tenantId, attempt.reading_id, attempt.id, attempt.trigger, attempt.status, attempt.stage ?? null,
          attempt.started_at, attempt.finished_at ?? null, json(attempt.error ?? null), JSON.stringify(attempt.events),
        ],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) return false;
      throw error;
    }
  }

  async listAttempts(id: string, limit = 20): Promise<ProcessingAttempt[]> {
    const rows = await this.sql.query(
      `SELECT a.id, a.trigger, a.status, a.stage, a.started_at, a.finished_at, a.error, a.events,
              a.reading_id, r.url, r.url_hash, r.key_prefix
       FROM reading_attempts a
       JOIN readings r ON (r.tenant_id, r.id) = (a.tenant_id, a.reading_id)
       WHERE a.tenant_id = $1 AND a.reading_id = $2
       ORDER BY a.started_at DESC, a.id DESC LIMIT $3`,
      [this.tenantId, id, limit],
    );
    return rows.map((row) =>
      ProcessingAttemptSchema.parse(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))),
    );
  }

  async setAttemptContent(ref: AttemptRef, content: AttemptContentKeys): Promise<void> {
    await this.sql.query(
      `UPDATE reading_attempts SET raw_key = $4, extracted_key = $5
       WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
      [this.tenantId, ref.id, resolveAttemptId(ref), content.rawKey, content.extractedKey],
    );
  }

  async readCheckpoint(ref: AttemptRef): Promise<unknown | null> {
    const [row] = await this.sql.query<{ checkpoint: unknown | null }>(
      "SELECT checkpoint FROM reading_attempts WHERE tenant_id = $1 AND reading_id = $2 AND id = $3",
      [this.tenantId, ref.id, resolveAttemptId(ref)],
    );
    return row?.checkpoint ?? null;
  }

  async writeCheckpoint(ref: AttemptRef, checkpoint: unknown): Promise<void> {
    await this.sql.query(
      `UPDATE reading_attempts SET checkpoint = $4::jsonb
       WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
      [this.tenantId, ref.id, resolveAttemptId(ref), JSON.stringify(checkpoint)],
    );
  }

  // The tenant's own row, locked FOR SHARE: several of these transactions may
  // hold it at once, and `DELETE /api/account`'s status UPDATE waits for all
  // of them. FOR SHARE, not FOR UPDATE, so a tenant's readings still claim and
  // publish in parallel.
  //
  // A missing row is inactive too. Teardown deletes `users` last, after the
  // wipe, and a request that authenticated before that can reach its claim
  // after it. `claimUrl` INSERTs rather than locking something that already
  // exists, so treating absence as active would let it write a reading, a URL
  // row, an attempt and a job for a tenant that no longer exists — rows no
  // wipe and no cron could ever find again, because they are reached through
  // `users`. The reading tables carry no foreign key to `users`, so this
  // check, not the schema, is what keeps that from happening.
  private async tenantIsActive(tx: SqlQuery): Promise<boolean> {
    const [row] = await tx.query<{ status: string }>(
      "SELECT status FROM users WHERE id = $1 FOR SHARE",
      [this.tenantId],
    );
    return row?.status === "active";
  }

  private async lock(tx: SqlQuery, id: string): Promise<LockedRow | null> {
    const [row] = await tx.query<LockedRow>(
      `SELECT status, active_attempt, last_attempt, key_prefix, url_hash, current_revision_id, created_at, updated_at
       FROM readings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [this.tenantId, id],
    );
    if (!row) return null;
    // JSONB NULL arrives as null; the ownership rules read absence.
    return { ...row, active_attempt: row.active_attempt ?? undefined, last_attempt: row.last_attempt ?? undefined };
  }

  // True when this reading owns its URL. An unowned URL is claimed when asked
  // (a legacy reading published without a pointer); otherwise an unowned URL
  // does not stop publication, as it did not before.
  private async resolveUrlOwnership(
    tx: SqlQuery,
    ref: AttemptRef & { urlHash: string },
    claimMissing: boolean,
  ): Promise<boolean> {
    if (claimMissing) {
      await tx.query(
        `INSERT INTO reading_urls (tenant_id, url_hash, reading_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [this.tenantId, ref.urlHash, ref.id],
      );
    }
    const [owner] = await tx.query<{ reading_id: string }>(
      "SELECT reading_id FROM reading_urls WHERE tenant_id = $1 AND url_hash = $2",
      [this.tenantId, ref.urlHash],
    );
    return owner === undefined || owner.reading_id === ref.id;
  }

  // A published reading keeps its revision, summary and embedding; only the
  // attempt summaries change.
  private async recordFailedAttempt(
    tx: SqlQuery,
    id: string,
    lastAttempt: ProcessingAttemptSummary | undefined,
    now: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE readings SET active_attempt = NULL, last_attempt = $3::jsonb, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id, json(lastAttempt ?? null), now],
    );
  }

  private async updateReading(tx: SqlQuery, manifest: Manifest, revisionId?: string): Promise<void> {
    const row = manifestToRows(manifest, { tenantId: this.tenantId, keyPrefix: "", ownsUrl: false }).reading;
    const values: unknown[] = [this.tenantId, manifest.id];
    const sets = MUTABLE_COLUMNS.map((column) => {
      values.push(JSONB_COLUMNS.has(column) ? json(row[column]) : row[column]);
      return `${column} = $${values.length}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`;
    });
    if (revisionId !== undefined) {
      values.push(revisionId);
      sets.push(`current_revision_id = $${values.length}`);
    }
    await tx.query(`UPDATE readings SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`, values);
  }

  private async insertAttempt(tx: SqlQuery, readingId: string, attempt: NewAttempt): Promise<void> {
    const s = attempt.summary;
    // Idempotent on the attempt id. Ids are random, so a conflict means the same
    // attempt is being activated again (a caller retrying an activation it
    // could not confirm): restart its row rather than fail the request. A paid
    // checkpoint already stored under the id is kept, which is its whole point.
    await tx.query(
      `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, stage, started_at, raw_key, extracted_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, reading_id, id) DO UPDATE SET
         trigger = EXCLUDED.trigger, status = EXCLUDED.status, stage = EXCLUDED.stage,
         started_at = EXCLUDED.started_at, finished_at = NULL, error = NULL, events = '[]',
         raw_key = EXCLUDED.raw_key, extracted_key = EXCLUDED.extracted_key`,
      [
        this.tenantId, readingId, s.id, s.trigger, s.status, s.stage ?? null, s.started_at,
        attempt.content?.rawKey ?? null, attempt.content?.extractedKey ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO reading_jobs (tenant_id, reading_id, attempt_id, state, payload, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, $5, $5)
       ON CONFLICT (tenant_id, reading_id, attempt_id) DO UPDATE SET
         state = 'queued', payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [this.tenantId, readingId, s.id, JSON.stringify(attempt.payload), s.started_at],
    );
  }

  private async finishAttempt(
    tx: SqlQuery,
    readingId: string,
    summary: ProcessingAttemptSummary,
    jobState: "done" | "dead" | "send_failed",
  ): Promise<void> {
    await tx.query(
      `UPDATE reading_attempts SET status = $4, stage = $5, finished_at = $6, error = $7::jsonb
       WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
      [this.tenantId, readingId, summary.id, summary.status, summary.stage ?? null, summary.finished_at ?? null, json(summary.error ?? null)],
    );
    await this.setJobState(tx, readingId, summary.id, jobState);
  }

  private async setJobState(tx: SqlQuery, readingId: string, attemptId: string, state: string): Promise<void> {
    await tx.query(
      `UPDATE reading_jobs SET state = $4, updated_at = now()
       WHERE tenant_id = $1 AND reading_id = $2 AND attempt_id = $3`,
      [this.tenantId, readingId, attemptId, state],
    );
  }

  private async deleteEmbedding(tx: SqlQuery, id: string): Promise<boolean> {
    const gone = await tx.query(
      "DELETE FROM reading_embeddings WHERE tenant_id = $1 AND reading_id = $2 RETURNING 1",
      [this.tenantId, id],
    );
    return gone.length > 0;
  }
}

function isPublished(row: LockedRow): boolean {
  return row.status === "ready" && row.current_revision_id !== null;
}
