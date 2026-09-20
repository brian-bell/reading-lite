// The corpus view the operator commands read and mutate (ADR 0005,
// reading-lite-gh347.4). It replaces the `index/list.json` walk and the
// per-reading manifest GETs in scripts/corpus-lib/wrangler-r2.ts.
//
// Reads delegate to PgReadingStore, the same store the router uses, so the
// operator and the Worker cannot disagree about what a reading is. Only the
// writes live here: they are deletions no request path performs, and they
// exist because an operator repairs what the runtime cannot reach.
//
// Captured content is still in R2. This view hands out the relative keys a
// reading currently points at; reading the bytes stays the caller's job.

import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest } from "../../src/schemas/manifest";
import type { Sql, SqlQuery } from "../../src/modules/db/sql";
import { PgReadingStore, type ContentKeys, type UrlOwner } from "../../src/modules/stores/postgres/reading-store";
import { PgSimilarityStore } from "../../src/modules/stores/postgres/similarity-store";
import type { SimilarityMatch } from "../../src/modules/stores/similarity-store";
import { r2KeyLayout, rawExtFromContentType } from "../../src/modules/stores/layout";
import type { OperatorTenant } from "../corpus-lib/tenant";
import type { ListItem } from "../corpus-lib/types";
import { UsageError } from "../ops-lib/contract";

/**
 * corpus-lib types its own ListItem by hand so the scripts do not import
 * worker schemas. The store returns the worker's ListIndexItem, which is a
 * superset; this is the one place the two meet.
 */
export function toListItem(item: ListIndexItem): ListItem {
  return {
    id: item.id,
    url: item.url,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    key_prefix: item.key_prefix,
    title: item.title,
    // corpus sweep ranks duplicates by these; dropping them would make every
    // copy score zero and silently reduce the ranking to "newest wins".
    tldr: item.tldr,
    tags: item.tags,
    keywords: item.keywords,
    source_date: item.source_date,
    error: item.error,
    active_attempt: item.active_attempt,
    last_attempt: item.last_attempt,
    enrichment_degradation: item.enrichment_degradation,
  };
}

/**
 * `--tenant global` addressed the pre-tenant R2 key root, which has no
 * PostgreSQL representation: tenant_id is a column, and the retained
 * pre-tenant objects were never imported. Commands fail closed on it rather
 * than silently addressing the live corpus.
 */
export function requirePgTenant(tenant: OperatorTenant): string {
  if (tenant.kind === "global") {
    throw new UsageError(
      "--tenant global has no PostgreSQL corpus: the retained pre-tenant objects live only in R2 " +
        "and are addressed by #348 (import) and #351 (retirement). Pass a tenant id (usr_…).",
    );
  }
  return tenant.tenantId;
}

/**
 * What a command may ask of the corpus, split by capability so a read-only
 * command cannot be handed deletion and so tests fake the two lines they use
 * rather than a whole store.
 */
export interface CorpusInventory {
  listItems(): Promise<ListItem[]>;
  contentKeys(id: string): Promise<ContentKeys | null>;
  stuckStages(ids: readonly string[]): Promise<Map<string, string>>;
}

export interface CorpusDropView extends CorpusMutations {
  listItems(): Promise<ListItem[]>;
  contentKeysForDrop(id: string): Promise<string[]>;
}

export interface CorpusLookup {
  manifest(id: string): Promise<Manifest | null>;
  keyPrefix(id: string): Promise<string | null>;
  ownerByUrl(url: string): Promise<UrlOwner | null>;
}

export interface CorpusMutations {
  deleteReading(id: string): Promise<boolean>;
  countInboundRelationships(targetId: string): Promise<number>;
  deleteInboundRelationships(targetId: string): Promise<number>;
}

/** What the refresh passes need: measure neighbours, then record the snapshot. */
export interface CorpusSimilarity {
  neighboursOf(id: string, topK: number): Promise<SimilarityMatch[] | null>;
  setSimilarity(id: string, similarity: unknown): Promise<boolean>;
}

export class OperatorCorpus
  implements CorpusInventory, CorpusLookup, CorpusMutations, CorpusDropView, CorpusSimilarity
{
  private readonly store: PgReadingStore;

  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
  ) {
    this.store = new PgReadingStore(sql, tenantId);
  }

  /** Every reading of this tenant, newest first — the replacement for index/list.json. */
  async listItems(): Promise<ListItem[]> {
    return (await this.store.allListItems()).map(toListItem);
  }

  /** The reading as a Manifest, the shape every corpus command already reasons about. */
  async manifest(id: string): Promise<Manifest | null> {
    return (await this.store.loadReadingById(id))?.manifest ?? null;
  }

  async keyPrefix(id: string): Promise<string | null> {
    return (await this.store.loadReadingById(id))?.keyPrefix ?? null;
  }

  async ownerByUrl(url: string): Promise<UrlOwner | null> {
    return this.store.findOwnerByUrl(url);
  }

  /** The relative R2 keys the reading points at now. */
  async contentKeys(id: string): Promise<ContentKeys | null> {
    return this.store.contentKeys(id);
  }

  /**
   * Deletes the reading. Its URL ownership, revisions, relationships,
   * embedding and attempts cascade, which is why this replaces a prefix
   * delete, a pointer delete, a list-index rewrite and a Vectorize delete.
   * Returns false when no such reading exists, so a re-run is a no-op rather
   * than an error.
   *
   * Captured content in R2 is NOT removed here: the bytes outlive the row and
   * the caller deletes the prefix, exactly as reading-purge does.
   */
  async deleteReading(id: string): Promise<boolean> {
    const deleted = await this.sql.execute("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [this.tenantId, id]);
    return deleted > 0;
  }

  /** How many relationships name this reading as their target — plan mode's answer. */
  async countInboundRelationships(targetId: string): Promise<number> {
    const [row] = await this.sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reading_relationships WHERE tenant_id = $1 AND target_id = $2",
      [this.tenantId, targetId],
    );
    return row?.n ?? 0;
  }

  /**
   * Removes relationships that NAME this reading as their target.
   *
   * reading_relationships keys the source only, so deleting a reading cascades
   * its outbound rows and leaves every inbound one dangling — detail reads
   * tolerate a missing target, but the rows accumulate and keep naming a
   * reading that is gone. This is `corpus purge-connections`.
   */
  async deleteInboundRelationships(targetId: string): Promise<number> {
    return this.sql.execute("DELETE FROM reading_relationships WHERE tenant_id = $1 AND target_id = $2", [
      this.tenantId,
      targetId,
    ]);
  }

  /**
   * Every relative R2 key this reading's rows still reference: the current
   * revision's, each other revision's, and each attempt's.
   *
   * This is what a drop has to delete, and it is enumerated from rows rather
   * than composed from the key prefix because each attempt captured under its
   * own immutable revision prefix — the legacy spelling is one possible key
   * among many, and only a reading no attempt ever touched still uses it.
   *
   * KNOWN GAP, narrower than the runtime's. `src/reading-purge.ts` deletes the
   * whole `key_prefix`; this deletes the keys rows name. Anything else under
   * that prefix survives the row delete with nothing left to name it — a
   * manifest.json or attempts/*.json on a reading imported from the pre-PG R2
   * layout (#348), or a revision object whose row was never written. The
   * operator path reaches R2 through the wrangler CLI, which has no prefix
   * listing, so closing this properly means giving drop and sweep the S3
   * inventory client. Until then the account wipe, which does list the prefix,
   * is what collects the remainder.
   */
  async contentKeysForDrop(id: string): Promise<string[]> {
    const rows = await this.sql.query<{ raw_key: string | null; extracted_key: string | null }>(
      `SELECT raw_key, extracted_key FROM reading_revisions WHERE tenant_id = $1 AND reading_id = $2
       UNION
       SELECT raw_key, extracted_key FROM reading_attempts WHERE tenant_id = $1 AND reading_id = $2`,
      [this.tenantId, id],
    );
    const [reading] = await this.sql.query<{ key_prefix: string; content_type: string }>(
      "SELECT key_prefix, content_type FROM readings WHERE tenant_id = $1 AND id = $2",
      [this.tenantId, id],
    );
    if (!reading) return [];

    // Every key must sit under THIS reading's stored prefix. The keys come
    // from rows rather than from a composed path, so a drifted or hand-edited
    // raw_key would otherwise send a delete at another reading's content — the
    // id-scoped prefix guard in corpus drop validates the prefix, not these
    // keys, so this is where that guard has to bind.
    const keys = new Set<string>();
    const under = (key: string | null): key is string =>
      key !== null && key.startsWith(`${reading.key_prefix}/`);
    for (const row of rows) {
      if (row.raw_key && !under(row.raw_key)) {
        throw new Error(`refusing to delete ${row.raw_key}: outside ${id}'s prefix ${reading.key_prefix}`);
      }
      if (row.extracted_key && !under(row.extracted_key)) {
        throw new Error(`refusing to delete ${row.extracted_key}: outside ${id}'s prefix ${reading.key_prefix}`);
      }
      if (row.raw_key) keys.add(row.raw_key);
      if (row.extracted_key) keys.add(row.extracted_key);
    }
    if (keys.size > 0) return [...keys];

    // No revision and no capturing attempt: an imported reading no attempt has
    // ever touched still serves the legacy spelling under its stored prefix,
    // which PgReadingStore.contentKeys falls back to as well. Without this the
    // drop would delete nothing, delete the row, and strand the bytes with
    // nothing left to name them — the exact outcome shouldDeleteRow exists to
    // prevent.
    const layout = r2KeyLayout("");
    return [
      layout.rawKey(reading.key_prefix, rawExtFromContentType(reading.content_type)),
      layout.extractedKey(reading.key_prefix),
    ];
  }

  /**
   * The stage each reading's ACTIVE attempt last reported, for the readings
   * asked about — `corpus audit --deep`'s "where is it really stuck".
   *
   * One query replaces two R2 GETs per stranded reading (the manifest for the
   * attempt id, then the attempt log), because the events the attempt appended
   * are a column on the attempt row.
   */
  async stuckStages(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.sql.query<{ id: string; stage: string | null; status: string | null }>(
      `SELECT r.id,
              a.events -> -1 ->> 'stage' AS stage,
              a.events -> -1 ->> 'status' AS status
       FROM readings r
       JOIN reading_attempts a
         ON (a.tenant_id, a.reading_id, a.id) = (r.tenant_id, r.id, r.active_attempt ->> 'id')
       WHERE r.tenant_id = $1 AND r.id = ANY ($2::text[])
         AND jsonb_array_length(a.events) > 0`,
      [this.tenantId, [...ids]],
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      // An event can carry a stage without a status. Report the stage alone
      // rather than the literal "summarize/null" in the audit report.
      if (row.stage) out.set(row.id, row.status ? `${row.stage}/${row.status}` : row.stage);
    }
    return out;
  }

  /**
   * The reading's neighbours, measured from the embedding it already owns.
   *
   * No provider spend and no re-embedding: the vector is the one stored, so a
   * fresh embedding cannot drift from the indexed one. Null means the reading
   * has no embedding at all, which is a different answer from "no
   * neighbours" and the refresh reports it as a failed measurement.
   */
  async neighboursOf(id: string, topK: number): Promise<SimilarityMatch[] | null> {
    return new PgSimilarityStore(this.sql, this.tenantId).queryByVectorId(id, topK);
  }

  /**
   * Records a similarity snapshot and nothing else.
   *
   * This used to be two writes that had to be kept in step — the manifest, and
   * then the row in index/list.json — with the list row doubling as the
   * resumability marker for a retry that found a written manifest and a stale
   * index. They are one column now, so the pair cannot diverge and there is
   * nothing to resume.
   *
   * `updated_at` is deliberately untouched: no content changed, and bumping it
   * would misreport the reading as freshly written to anything ordering by it.
   */
  async setSimilarity(id: string, similarity: unknown): Promise<boolean> {
    const changed = await this.sql.execute(
      "UPDATE readings SET similarity = $3 WHERE tenant_id = $1 AND id = $2",
      [this.tenantId, id, similarity === null ? null : JSON.stringify(similarity)],
    );
    return changed > 0;
  }

  /** Escape hatch for a command with a query of its own; still tenant-scoped by the caller. */
  get query(): SqlQuery["query"] {
    return this.sql.query.bind(this.sql);
  }
}

export function operatorCorpusFor(sql: Sql, tenant: OperatorTenant): OperatorCorpus {
  return new OperatorCorpus(sql, requirePgTenant(tenant));
}

/**
 * Resolves the tenant BEFORE anything opens a connection.
 *
 * Every ported command passes `operatorDatabaseUrl(...)` as an argument to
 * `withOperatorSql`, so it is evaluated before `operatorCorpusFor` runs. That
 * made `--tenant global` report "DATABASE_URL is not set" when no string was
 * set, and open a session only to throw when one was. Commands call this
 * first so the refusal says what is actually wrong.
 */
export function assertPgTenant(tenant: OperatorTenant): void {
  requirePgTenant(tenant);
}
