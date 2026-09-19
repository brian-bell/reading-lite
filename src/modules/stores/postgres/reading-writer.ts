// PostgreSQL write store for readings (ADR 0005). Every verb is one
// transaction that locks the reading row first, so ownership is decided and
// acted on atomically. That lock replaces the etag CAS on manifest.json, the
// index/list.json CAS loop, the by-url pointer CAS, the purge tombstone and the
// ledger-before-manifest ordering.
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

export type ClaimOutcome = { kind: "claimed" } | { kind: "owned"; ownerId: string | null };

export type StartAttemptOutcome =
  | { kind: "started" }
  | { kind: "not_found" }
  // The reading's active attempt is not the one the caller decided on.
  | { kind: "conflict" };

export interface CommitOutcome {
  // The terminal state was written by this attempt.
  committed: boolean;
  // The reading is searchable: it owns its URL and its embedding was stored.
  published: boolean;
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

// Thrown inside claimUrl's transaction to roll back the reading it inserted.
class UrlAlreadyOwned extends Error {}

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
  async claimUrl(pending: Manifest, keyPrefix: string, attempt: NewAttempt): Promise<ClaimOutcome> {
    const rows = manifestToRows(pending, { tenantId: this.tenantId, keyPrefix, ownsUrl: true });
    try {
      await this.sql.transaction(async (tx) => {
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
  // up again in place. `seenActiveAttemptId` is the active attempt the caller
  // made its decision on; if another attempt activated since, this one yields.
  async startAttempt(
    next: Manifest,
    attempt: NewAttempt,
    seenActiveAttemptId: string | undefined,
  ): Promise<StartAttemptOutcome> {
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, next.id);
      if (!row) return { kind: "not_found" };
      if (row.active_attempt?.id !== seenActiveAttemptId) return { kind: "conflict" };
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
  async failActivation(ref: AttemptRef, rolledBack: Manifest, failed: ProcessingAttemptSummary): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, ref.id);
      if (!row || !attemptOwnership(row, ref).isActive) return false;
      await this.updateReading(tx, rolledBack);
      await this.finishAttempt(tx, ref.id, failed, "send_failed");
      return true;
    });
  }

  // Publication. Ownership is verified under the row lock, then the revision,
  // the reading, its relationships and its embedding commit in one
  // transaction: a reader never sees a summary without its content keys, or a
  // searchable vector for a reading that is not ready.
  //
  // The order inside the transaction is the contract: lock, ownership, URL
  // ownership, revision, reading, relationships, embedding, attempt. Nothing is
  // written before ownership is settled.
  async publish(
    ref: AttemptRef & { urlHash: string },
    ready: Manifest,
    opts: { keyPrefix: string; content: AttemptContentKeys; embedding: readonly number[] | null; claimMissingUrl: boolean },
  ): Promise<CommitOutcome> {
    if (ready.status !== "ready") throw new Error("publish: manifest is not ready");
    const attemptId = resolveAttemptId(ref);
    return this.sql.transaction(async (tx) => {
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
      // Only the URL's owner is searchable. A duplicate that does not own its
      // URL is stored but keeps no vector, as it kept none in Vectorize.
      const searchable = ownsUrl && opts.embedding !== null;
      if (searchable) {
        await upsertEmbedding(tx, this.tenantId, ref.id, opts.embedding!);
      } else {
        await this.deleteEmbedding(tx, ref.id);
      }
      if (ready.last_attempt) await this.finishAttempt(tx, ref.id, ready.last_attempt, "done");
      return { committed: true, published: searchable };
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
      if (row.status === "ready" && row.current_revision_id !== null) {
        await tx.query(
          `UPDATE readings SET active_attempt = NULL, last_attempt = $3::jsonb, updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, ref.id, json(failed.last_attempt ?? null), opts.now],
        );
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
  async replacePublishedIf(
    id: string,
    matches: (current: Manifest) => boolean | Promise<boolean>,
    next: Manifest,
  ): Promise<boolean> {
    if (next.status !== "ready") throw new Error("replacePublishedIf: manifest is not ready");
    return this.sql.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row || row.status !== "ready" || row.current_revision_id === null) return false;
      const current = await new PgReadingStore(tx, this.tenantId).loadReadingById(id);
      if (!current || !(await matches(current.manifest))) return false;

      const rows = manifestToRows(next, { tenantId: this.tenantId, keyPrefix: row.key_prefix, ownsUrl: false });
      const v = rows.revision!;
      await this.updateReading(tx, next);
      await tx.query(
        `UPDATE reading_revisions SET summary_markdown = $4, usage = $5::jsonb, connections_present = $6,
           tensions_present = $7, connections_computed_at = $8, connections_neighbourhood_ids = $9,
           tensions_judged = $10::jsonb
         WHERE tenant_id = $1 AND reading_id = $2 AND id = $3`,
        [
          this.tenantId, id, row.current_revision_id, v.summary_markdown, json(v.usage), v.connections_present,
          v.tensions_present, v.connections_computed_at, v.connections_neighbourhood_ids, json(v.tensions_judged),
        ],
      );
      await tx.query("DELETE FROM reading_relationships WHERE tenant_id = $1 AND source_id = $2", [this.tenantId, id]);
      await insertRelationships(tx, this.tenantId, id, rows.relationships);
      return true;
    });
  }

  // Reading purge. `isRunning` is the caller's staleness rule, evaluated under
  // the lock so a purge and an activation cannot both win. Deleting the row
  // cascades to the URL, revisions, relationships, embedding, attempts and
  // jobs, and is the fence that stops a late consumer from republishing. The
  // caller deletes the R2 prefix afterwards.
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
      await tx.query("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [this.tenantId, id]);
      return { kind: "purged", keyPrefix: row.key_prefix, urlReleased: url.length > 0, embeddingRemoved };
    });
  }

  // Compensation for a tenant that stopped being eligible around a publish.
  async removeEmbedding(id: string): Promise<void> {
    await this.deleteEmbedding(this.sql, id);
  }

  // Account wipe: every reading row the tenant owns, children by cascade.
  async deleteAllReadings(): Promise<number> {
    const [row] = await this.sql.query<{ deleted: number }>(
      `WITH gone AS (DELETE FROM readings WHERE tenant_id = $1 RETURNING 1)
       SELECT count(*)::int AS deleted FROM gone`,
      [this.tenantId],
    );
    return row!.deleted;
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
    await tx.query(
      `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, stage, started_at, raw_key, extracted_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        this.tenantId, readingId, s.id, s.trigger, s.status, s.stage ?? null, s.started_at,
        attempt.content?.rawKey ?? null, attempt.content?.extractedKey ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO reading_jobs (tenant_id, reading_id, attempt_id, state, payload, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, $5, $5)`,
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
