import { resolveAttemptId, type ProcessReadingArgs } from "./attempt-ownership";
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
// the reading's rows, its attempt log and paid checkpoint, similarity, and the
// content it captures. Content goes under the attempt's own immutable revision
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

  // An attempt that lost its reading (purged, or taken over) deletes what it
  // captured. Nothing references these keys: only a publish would have.
  async discardCapturedContent(): Promise<void> {
    await this.content.deletePrefix(
      `${this.args.keyPrefix}/${REVISIONS_PREFIX}${resolveAttemptId(this.args)}`,
    );
  }

  private async recordContent(): Promise<void> {
    const captured = this.capturedContent();
    if (captured) await this.writer.setAttemptContent(this.args, captured);
  }
}
