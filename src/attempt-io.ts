import { resolveAttemptId, type ProcessReadingArgs } from "./attempt-ownership";
import { fromSql, type ControlPlaneDb } from "./control-plane/db";
import type { TenantContext } from "./control-plane/ids";
import type { Sql } from "./modules/db/sql";
import { ProcessingCheckpointSchema, type ProcessingCheckpoint } from "./modules/processing-checkpoint";
import { contentStoreFor, type ContentStore } from "./modules/stores/content-store";
import { r2KeyLayout, REVISIONS_PREFIX } from "./modules/stores/layout";
import { pgReadingStoreFor, type PgReadingStore } from "./modules/stores/postgres/reading-store";
import {
  pgReadingWriterFor,
  type AttemptContentKeys,
  type PgReadingWriter,
} from "./modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor, type PgSimilarityStore } from "./modules/stores/postgres/similarity-store";
import type { Manifest, ProcessingAttempt } from "./schemas/manifest";

// Everything one processing attempt reads and writes, bound to that attempt:
// the reading's rows, its attempt log and paid checkpoint, similarity, the
// content it captures, and the control-plane rows (tenant status, recipient)
// it checks on the way. Content goes under the attempt's own immutable revision
// keys (ADR 0005), so no attempt can overwrite what a published revision
// points at, and a failed reprocess leaves that content in place.
//
// Below the pipeline (`process-reading.ts`) and above the stores, so the
// pipeline never spells a key or a tenant id.

const layout = r2KeyLayout("");

export function attemptIoFor(
  sql: Sql,
  env: { READINGS_BUCKET: R2Bucket; TENANT_DATA_PLANE?: string },
  tenant: TenantContext,
  args: ProcessReadingArgs,
): AttemptIo {
  return new AttemptIo(
    pgReadingStoreFor(sql, tenant),
    pgReadingWriterFor(sql, tenant),
    contentStoreFor(env.READINGS_BUCKET, tenant, env),
    pgSimilarityStoreFor(sql, tenant),
    fromSql(sql),
    args,
  );
}

export class AttemptIo {
  private rawKey: string | null = null;
  private extractedKey: string | null = null;

  constructor(
    readonly store: PgReadingStore,
    readonly writer: PgReadingWriter,
    readonly content: ContentStore,
    readonly similarity: PgSimilarityStore,
    readonly controlPlane: ControlPlaneDb,
    private readonly args: ProcessReadingArgs,
  ) {}

  // Null once the reading is purged: the row is the only witness there is.
  async readManifest(): Promise<Manifest | null> {
    return (await this.store.loadReadingById(this.args.id))?.manifest ?? null;
  }

  // False when the reading is gone; the foreign key refuses to recreate a log.
  async writeAttempt(attempt: ProcessingAttempt): Promise<boolean> {
    return this.writer.recordAttempt(attempt);
  }

  async readCheckpoint(): Promise<ProcessingCheckpoint | null> {
    const stored = await this.writer.readCheckpoint(this.args);
    return stored === null ? null : ProcessingCheckpointSchema.parse(stored);
  }

  async writeCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    await this.writer.writeCheckpoint(this.args, checkpoint);
  }

  async writeRaw(ext: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const key = layout.revisionRawKey(this.args.keyPrefix, resolveAttemptId(this.args), ext);
    await this.content.put(key, bytes, contentType);
    this.rawKey = key;
    await this.recordContent();
  }

  async writeExtracted(markdown: string): Promise<void> {
    const key = layout.revisionExtractedKey(this.args.keyPrefix, resolveAttemptId(this.args));
    await this.content.put(key, markdown, "text/markdown; charset=utf-8");
    this.extractedKey = key;
    await this.recordContent();
  }

  // The keys this attempt captured under, for the revision a publish creates.
  // Null until the raw object is written.
  capturedContent(): AttemptContentKeys | null {
    return this.rawKey === null ? null : { rawKey: this.rawKey, extractedKey: this.extractedKey };
  }

  async discardUnreferencedContent(): Promise<void> {
    await discardUnreferencedContent(this.store, this.content, this.args);
  }

  // The content of the revision this attempt's publication replaced. Its row
  // is gone (PgReadingWriter.publish), so nothing resolves these keys any
  // more. Guarded the way discardUnreferencedContent is: the reading's
  // current keys are read first, and whatever they still point at stays,
  // this attempt's own prefix included. Content under a revision prefix goes
  // with its prefix; the legacy spelling shares key_prefix with everything
  // else, so only its two objects go.
  //
  // A read that resolved the old keys just before this delete re-resolves
  // them on a missing object (router.ts readContent), which is what makes
  // deleting here, rather than deferring, safe for in-flight requests.
  async discardSupersededContent(keys: AttemptContentKeys): Promise<void> {
    const revisions = layout.revisionsPrefix(this.args.keyPrefix);
    const own = `${revisions}${resolveAttemptId(this.args)}/`;
    if (keys.rawKey.startsWith(own)) return;
    const current = await this.store.contentKeys(this.args.id);
    if (current && (current.rawKey === keys.rawKey || (keys.extractedKey !== null && current.extractedKey === keys.extractedKey))) return;
    if (keys.rawKey.startsWith(revisions)) {
      await this.content.deletePrefix(keys.rawKey.slice(0, keys.rawKey.lastIndexOf("/") + 1));
      return;
    }
    await this.content.delete(keys.extractedKey === null ? [keys.rawKey] : [keys.rawKey, keys.extractedKey]);
  }

  private async recordContent(): Promise<void> {
    const captured = this.capturedContent();
    if (captured) await this.writer.setAttemptContent(this.args, captured);
  }
}

// An attempt that lost its reading (purged, taken over, failed beside a
// published revision, or never activated) deletes what it captured, because
// nothing references it. The check is here, not at the call sites, because
// getting it wrong destroys published content: a redelivered message for an
// attempt that already published reaches the same "this attempt may not write"
// exits, and its revision prefix is the live content. A never-published
// reading also serves its latest attempt's bytes. So: sweep only when the
// reading is gone or points somewhere else.
export async function discardUnreferencedContent(
  store: PgReadingStore,
  content: ContentStore,
  attempt: Pick<ProcessReadingArgs, "id" | "keyPrefix" | "attemptId">,
): Promise<void> {
  const prefix = `${attempt.keyPrefix}/${REVISIONS_PREFIX}${resolveAttemptId(attempt)}/`;
  const current = await store.contentKeys(attempt.id);
  if (current?.rawKey.startsWith(prefix)) return;
  await content.deletePrefix(prefix);
}
