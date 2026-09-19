// What a test needs to arrange and inspect reading state now that it lives in
// PostgreSQL rows (ADR 0005): seed a reading the way the importer would, and
// read it back the way the API does. Workers pool only.
//
// The connection is per operation, so there is nothing to close. Tests on the
// file's fixed tenants are cleaned before each test by apply-control-plane.ts;
// tests that want isolation within a file mint a tenant.
import { env } from "cloudflare:test";
import type { TenantContext } from "../../src/control-plane/ids";
import { sqlPerOperationFor, type Sql } from "../../src/modules/db/sql";
import { contentStoreFor, type ContentStore } from "../../src/modules/stores/content-store";
import { buildKeyPrefix, r2KeyLayout } from "../../src/modules/stores/layout";
import { manifestToRows, writeReadingRows } from "../../src/modules/stores/postgres/manifest-rows";
import { pgReadingStoreFor, type PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import { pgReadingWriterFor, type PgReadingWriter } from "../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor, type PgSimilarityStore } from "../../src/modules/stores/postgres/similarity-store";
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

export class TestReadings {
  readonly sql: Sql;
  readonly store: PgReadingStore;
  readonly writer: PgReadingWriter;
  readonly similarity: PgSimilarityStore;
  readonly content: ContentStore;

  constructor(readonly tenant: TenantContext) {
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
    const rows = manifestToRows(parsed, {
      tenantId: String(this.tenant.tenantId),
      keyPrefix,
      ownsUrl: opts.ownsUrl ?? true,
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

export function testReadingsFor(tenant: TenantContext): TestReadings {
  return new TestReadings(tenant);
}
