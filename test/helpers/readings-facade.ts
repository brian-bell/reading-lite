// What a test needs to arrange and inspect reading state now that it lives in
// PostgreSQL rows (ADR 0005): seed a reading the way the importer would, and
// read it back the way the API does.
//
// Pool-neutral: it takes the environment it should use. The workers pool builds
// one from `cloudflare:test` (./test-readings.ts); the Node pool builds one
// over a direct connection and a fake bucket (./node-readings.ts).
//
// The connection is per operation, so there is nothing to close.
import type { TenantContext } from "../../src/control-plane/ids";
import { sqlPerOperationFor, type Sql } from "../../src/modules/db/sql";
import { contentStoreFor, type ContentStore } from "../../src/modules/stores/content-store";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { manifestToRows, writeReadingRows } from "../../src/modules/stores/postgres/manifest-rows";
import { pgReadingStoreFor, type PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import { pgReadingWriterFor, type PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor, type PgSimilarityStore } from "../../src/modules/stores/postgres/similarity-store";
import type { ListIndexItem } from "../../src/schemas/api";
import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";

const layout = r2KeyLayout("");

export interface SeedOptions {
  keyPrefix?: string;
  // False seeds an orphan duplicate: a reading that does not own its URL.
  ownsUrl?: boolean;
  embedding?: readonly number[];
  // Content to put at the legacy keys, where an imported reading's bytes sit.
  extracted?: string;
  raw?: { ext: string; body: string | Uint8Array; contentType: string };
}

export interface ReadingsEnv {
  HYPERDRIVE: Hyperdrive;
  READINGS_BUCKET: R2Bucket;
  TENANT_DATA_PLANE?: string;
}

export class TestReadings {
  readonly sql: Sql;
  readonly store: PgReadingStore;
  readonly writer: PgReadingWriter;
  readonly similarity: PgSimilarityStore;
  readonly content: ContentStore;

  constructor(
    readonly tenant: TenantContext,
    env: ReadingsEnv,
  ) {
    this.sql = sqlPerOperationFor(env);
    this.store = pgReadingStoreFor(this.sql, tenant);
    this.writer = pgReadingWriterFor(this.sql, tenant);
    this.similarity = pgSimilarityStoreFor(this.sql, tenant);
    this.content = contentStoreFor(env.READINGS_BUCKET, tenant, env);
  }

  // Replaces the reading's rows wholesale, as the importer does.
  async seed(manifest: Manifest, opts: SeedOptions = {}): Promise<string> {
    const parsed = ManifestSchema.parse(manifest);
    const keyPrefix = opts.keyPrefix ?? buildKeyPrefix(parsed.id, parsed.created_at);
    // One reading owns a URL. Unless the test says otherwise, the first
    // reading seeded for a URL owns it and later ones are orphan duplicates,
    // which is how the importer resolves fixtures that share a URL.
    const [owner] = await this.sql.query<{ reading_id: string }>(
      "SELECT reading_id FROM reading_urls WHERE tenant_id = $1 AND url_hash = $2",
      [String(this.tenant.tenantId), parsed.url_hash],
    );
    const rows = manifestToRows(parsed, {
      tenantId: String(this.tenant.tenantId),
      keyPrefix,
      ownsUrl: opts.ownsUrl ?? (owner === undefined || owner.reading_id === parsed.id),
      embedding: opts.embedding,
    });
    await this.sql.transaction((tx) => writeReadingRows(tx, rows));
    if (opts.extracted !== undefined) {
      await this.content.put(layout.extractedKey(keyPrefix), opts.extracted, "text/markdown; charset=utf-8");
    }
    if (opts.raw) {
      await this.content.put(layout.rawKey(keyPrefix, opts.raw.ext), opts.raw.body, opts.raw.contentType);
    }
    return keyPrefix;
  }

  // For tests that think in list rows (what index/list.json held): seeds the
  // reading each row describes, with placeholder content facts.
  async seedListItems(items: readonly ListIndexItem[]): Promise<void> {
    for (const item of items) {
      const { key_prefix, ...fields } = item;
      await this.seed(
        {
          content_type: "text/html; charset=utf-8",
          content_status: "captured",
          content_bytes: 0,
          content_sha256: "0".repeat(64),
          ...(item.status === "ready" ? { connections: [] } : {}),
          ...fields,
          url_hash: await sha256Hex(item.url),
          updated_at: item.updated_at ?? item.created_at,
        },
        { keyPrefix: key_prefix },
      );
    }
  }

  // Rewrites a seeded reading's status and attempt state in place. Unlike
  // `seed`, it keeps the reading's attempt rows (and so its paid checkpoint),
  // which is what a test arranging a takeover or a stale attempt needs.
  async restate(manifest: Pick<Manifest, "id" | "status" | "active_attempt" | "last_attempt" | "error" | "updated_at">): Promise<void> {
    const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    await this.sql.query(
      `UPDATE readings SET status = $3, active_attempt = $4::jsonb, last_attempt = $5::jsonb,
         error = $6::jsonb, updated_at = $7
       WHERE tenant_id = $1 AND id = $2`,
      [
        String(this.tenant.tenantId), manifest.id, manifest.status, json(manifest.active_attempt),
        json(manifest.last_attempt), json(manifest.error), manifest.updated_at,
      ],
    );
  }

  // What DELETE /api/readings/:id does to the rows.
  async purge(id: string): Promise<void> {
    await this.writer.purge(id, () => false);
  }

  async manifest(id: string): Promise<Manifest | null> {
    return (await this.store.loadReadingById(id))?.manifest ?? null;
  }

  async keyPrefix(id: string): Promise<string | null> {
    return (await this.store.loadReadingById(id))?.keyPrefix ?? null;
  }

  async urlOwnerId(url: string): Promise<string | null> {
    const [row] = await this.sql.query<{ reading_id: string }>(
      "SELECT reading_id FROM reading_urls WHERE tenant_id = $1 AND url_hash = $2",
      [String(this.tenant.tenantId), await sha256Hex(url)],
    );
    return row?.reading_id ?? null;
  }

  async hasEmbedding(id: string): Promise<boolean> {
    return (await this.similarity.queryByVectorId(id, 1)) !== null;
  }

  async extractedText(id: string): Promise<string | null> {
    const keys = await this.store.contentKeys(id);
    const object = keys?.extractedKey ? await this.content.get(keys.extractedKey) : null;
    return object ? object.text() : null;
  }

  async rawText(id: string): Promise<string | null> {
    const keys = await this.store.contentKeys(id);
    const object = keys ? await this.content.get(keys.rawKey) : null;
    return object ? object.text() : null;
  }

  async jobState(id: string, attemptId: string): Promise<string | null> {
    const [row] = await this.sql.query<{ state: string }>(
      "SELECT state FROM reading_jobs WHERE tenant_id = $1 AND reading_id = $2 AND attempt_id = $3",
      [String(this.tenant.tenantId), id, attemptId],
    );
    return row?.state ?? null;
  }

  async ids(): Promise<string[]> {
    return (await this.store.allListItems()).map((item) => item.id);
  }
}
