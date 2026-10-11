// PostgreSQL read store for readings (ADR 0005). Returns the same
// ListIndexItem and Manifest shapes as ReadingStore, parsed with zod at the
// seam, so the router's contract did not change when it switched over.
//
// Every query is `WHERE tenant_id = $1`, and the only constructor validates
// the tenant id exactly as tenantKeyRoot does. Captured content stays in R2:
// this store hands out relative keys and ContentStore reads them.

import { z } from "zod";
import type { TenantContext } from "../../../control-plane/ids";
import { parseTenantId } from "../../../control-plane/ids";
import {
  DeskPositionSchema,
  ListIndexItemSchema,
  RelationshipRowSchema,
  type ListIndexItem,
  type RelationshipRow,
} from "../../../schemas/api";
import { ManifestSchema, type Manifest, type ManifestStatus } from "../../../schemas/manifest";
import { sha256Hex } from "../../../services";
import type { Sql, SqlQuery, SqlRow } from "../../db/sql";
import type { ListManifestsParams, ListManifestsResult } from "../list-items";
import { legacyContentKeys } from "./manifest-rows";

export function pgTenantId(tenant: TenantContext): string {
  const tenantId = parseTenantId(String(tenant.tenantId));
  if (!tenantId) {
    throw new Error("malformed tenant id");
  }
  return tenantId;
}

export function pgReadingStoreFor(sql: Sql, tenant: TenantContext): PgReadingStore {
  return new PgReadingStore(sql, pgTenantId(tenant));
}

export interface UrlOwner {
  id: string;
  status: ManifestStatus;
}

export interface ReadingSnapshot {
  keyPrefix: string;
  manifest: Manifest;
  // Opaque row version; equal to another read's only if nothing was written
  // to the row in between.
  version: string;
  // Beside the manifest, not in it: callers hash the manifest as its version,
  // and a desk toggle is not a change to the reading. The detail response and
  // the archive put it back as `desk_position`.
  deskPosition?: number;
}

export interface ContentKeys {
  // Relative R2 keys; compose the tenant root through r2KeyLayout to read.
  rawKey: string;
  extractedKey: string | null;
  contentType: string;
}

// Every list query selects FROM readings unaliased, so the desk position is a
// correlated read of the reading's one reading_desk row.
const LIST_COLUMNS = `id, key_prefix, url, title, tldr, tags, keywords, status, novelty_verdict,
  similarity, source_date, created_at, updated_at, error, active_attempt, last_attempt,
  enrichment_degradation,
  (SELECT k.position FROM reading_desk k WHERE k.tenant_id = readings.tenant_id AND k.reading_id = readings.id)
    AS desk_position`;

// The library card's counts: the row's own relationship rows, counting only
// targets that are still readings (a target has no foreign key, so it can
// dangle). Tensions are stored on both sides, so each side counts its own.
const RELATIONSHIP_COUNTS = ["connection", "tension"]
  .map(
    (kind) => `(SELECT count(*)::int FROM reading_relationships x
      JOIN readings t ON (t.tenant_id, t.id) = (x.tenant_id, x.target_id)
      WHERE x.tenant_id = readings.tenant_id AND x.source_id = readings.id AND x.kind = '${kind}') AS ${kind}_count`,
  )
  .join(", ");

// The relationship graph's columns: what its response carries, plus what
// read-time staleness decides over. Not LIST_COLUMNS, whose summaries,
// keywords and desk position the graph would read and throw away.
const GRAPH_COLUMNS = `readings.id, readings.url, readings.title, readings.tags, readings.status,
  readings.created_at, readings.updated_at, readings.error, readings.active_attempt, readings.last_attempt`;

const GraphReadingRowSchema = ListIndexItemSchema.pick({
  id: true,
  url: true,
  title: true,
  tags: true,
  status: true,
  created_at: true,
  updated_at: true,
  error: true,
  active_attempt: true,
  last_attempt: true,
});

// The list search: a case-insensitive substring over
// title, tldr, url and keywords, and a case-insensitive exact tag. strpos, not
// LIKE, so q needs no wildcard escaping. Stored tags keep their case. No
// trigram index yet; ADR 0005 names it as the scaling path.
const LIST_FILTER = `tenant_id = $1
  AND ($2 = '' OR strpos(lower(coalesce(title, '') || E'\\n' || coalesce(tldr, '') || E'\\n' || url || E'\\n'
    || array_to_string(coalesce(keywords, '{}'), E'\\n')), $2) > 0)
  AND ($3 = '' OR $3 = ANY (SELECT lower(t) FROM unnest(tags) AS t))`;

// NULL columns are absent manifest fields, never nulls.
function present(row: SqlRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}

export class PgReadingStore {
  constructor(
    // Reads only, so a transaction's query handle serves as well as a client.
    private readonly sql: SqlQuery,
    private readonly tenantId: string,
  ) {}

  async listManifests(params: ListManifestsParams): Promise<ListManifestsResult> {
    const q = params.q?.trim().toLowerCase() ?? "";
    const tag = params.tag?.trim().toLowerCase() ?? "";
    // The page and its unpaged count come from one statement, so they are one
    // snapshot, as the single index/list.json read was. The id tiebreak is
    // deliberate: today's sort is stable on created_at alone.
    const rows = await this.sql.query<SqlRow & { total_filtered: number }>(
      `SELECT ${LIST_COLUMNS}, ${RELATIONSHIP_COUNTS}, count(*) OVER ()::int AS total_filtered
       FROM readings WHERE ${LIST_FILTER}
       ORDER BY created_at DESC, id DESC OFFSET $4 LIMIT $5`,
      [this.tenantId, q, tag, params.offset, params.limit],
    );
    // An empty page carries no window count: either nothing matched or the
    // offset is past the end, and only a count tells those apart.
    const total = rows.length > 0
      ? rows[0]!.total_filtered
      : (await this.sql.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM readings WHERE ${LIST_FILTER}`,
          [this.tenantId, q, tag],
        ))[0]!.total;
    return {
      readings: rows.map(({ total_filtered: _total, ...row }) => ListIndexItemSchema.parse(present(row))),
      total_filtered: total,
    };
  }

  // Every list row the tenant has, newest first: what index/list.json held.
  // For the scheduled jobs that scan a library (digests, relationship
  // refresh); request paths page with listManifests or key with
  // relationshipTargets instead.
  async allListItems(): Promise<ListIndexItem[]> {
    const rows = await this.sql.query(
      `SELECT ${LIST_COLUMNS} FROM readings WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`,
      [this.tenantId],
    );
    return rows.map((row) => ListIndexItemSchema.parse(present(row)));
  }

  // Keyset page of readings_library_order (tenant_id, created_at DESC, id DESC),
  // every status. `after` is the last row of the previous page; null is the
  // first page. A row inserted with a newer created_at between pages is not
  // visited, and a row already returned is not returned again.
  async listItemsKeyset(
    after: { createdAt: string; id: string } | null,
    limit: number,
  ): Promise<ListIndexItem[]> {
    const rows = after
      ? await this.sql.query(
          `SELECT ${LIST_COLUMNS} FROM readings
           WHERE tenant_id = $1 AND (created_at, id) < ($2::timestamptz, $3)
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [this.tenantId, after.createdAt, after.id, limit],
        )
      : await this.sql.query(
          `SELECT ${LIST_COLUMNS} FROM readings
           WHERE tenant_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
          [this.tenantId, limit],
        );
    return rows.map((row) => ListIndexItemSchema.parse(present(row)));
  }

  // Keyed replacement for the whole-index read behind relationship_targets.
  async relationshipTargets(ids: readonly string[]): Promise<ListIndexItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql.query(
      `SELECT ${LIST_COLUMNS} FROM readings WHERE tenant_id = $1 AND id = ANY ($2::text[])`,
      [this.tenantId, [...ids]],
    );
    return rows.map((row) => ListIndexItemSchema.parse(present(row)));
  }

  // The tenant's relationship graph (GET /api/readings/relationships): every
  // ready reading, plus any reading at either end of a relationship whose
  // target is live, each with its own outgoing rows in kind, position order.
  // One statement, so the readings and the rows are one snapshot. The rows are
  // grouped by source once and joined, rather than read by a correlated
  // subquery per reading: `rel` is referenced more than once, so it is
  // materialized, and a materialized CTE has no index to probe.
  async relationshipGraph(): Promise<{
    readings: z.infer<typeof GraphReadingRowSchema>[];
    relationships: RelationshipRow[];
  }> {
    const rows = await this.sql.query<SqlRow & { relationships: unknown }>(
      `WITH rel AS (
         SELECT x.source_id, x.kind, x.target_id, x.tension_kind, x.reason, x.position
         FROM reading_relationships x
         JOIN readings t ON (t.tenant_id, t.id) = (x.tenant_id, x.target_id)
         WHERE x.tenant_id = $1
       ),
       grouped AS (
         SELECT rel.source_id, json_agg(json_strip_nulls(json_build_object(
                  'source_id', rel.source_id, 'kind', rel.kind, 'target_id', rel.target_id,
                  'tension_kind', rel.tension_kind, 'reason', rel.reason))
                ORDER BY rel.kind, rel.position) AS relationships
         FROM rel GROUP BY rel.source_id
       )
       SELECT ${GRAPH_COLUMNS}, coalesce(grouped.relationships, '[]'::json) AS relationships
       FROM readings
       LEFT JOIN grouped ON grouped.source_id = readings.id
       WHERE readings.tenant_id = $1
         AND (readings.status = 'ready'
           OR readings.id IN (SELECT source_id FROM rel) OR readings.id IN (SELECT target_id FROM rel))
       ORDER BY readings.id`,
      [this.tenantId],
    );
    return {
      readings: rows.map(({ relationships: _rows, ...row }) => GraphReadingRowSchema.parse(present(row))),
      relationships: rows.flatMap((row) => z.array(RelationshipRowSchema).parse(row.relationships)),
    };
  }

  // Every copy of these URLs, owner or not: what `corpus drop` resolves a URL
  // selector against, without reading the corpus it is not about.
  async listItemsByUrls(urls: readonly string[]): Promise<ListIndexItem[]> {
    if (urls.length === 0) return [];
    const rows = await this.sql.query(
      `SELECT ${LIST_COLUMNS} FROM readings WHERE tenant_id = $1 AND url = ANY ($2::text[])`,
      [this.tenantId, [...urls]],
    );
    return rows.map((row) => ListIndexItemSchema.parse(present(row)));
  }

  // `version` is the row's xmin: it changes with every committed write to the
  // reading, so a writer that took `next` from this read can tell under its
  // lock whether the row is still the one it saw (PgReadingWriter.startAttempt).
  async loadReadingById(id: string): Promise<ReadingSnapshot | null> {
    const [row] = await this.sql.query(
      `SELECT r.xmin::text AS version, r.id, r.key_prefix, r.url, r.url_hash, r.source_type, r.status, r.error,
              r.active_attempt, r.last_attempt, r.title, r.tldr, r.tags, r.keywords, r.people,
              r.orgs, r.novelty_verdict, r.similarity, r.content_type, r.content_status,
              r.content_bytes, r.extracted_bytes, r.content_sha256, r.enrichment_degradation,
              r.source_date, r.fetched_at, r.created_at, r.updated_at,
              v.summary_markdown, v.usage, v.connections_computed_at,
              v.connections_neighbourhood_ids, v.tensions_judged,
              v.connections_present, v.tensions_present, k.position AS desk_position
       FROM readings r
       LEFT JOIN reading_revisions v
         ON (v.tenant_id, v.reading_id, v.id) = (r.tenant_id, r.id, r.current_revision_id)
       LEFT JOIN reading_desk k ON (k.tenant_id, k.reading_id) = (r.tenant_id, r.id)
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [this.tenantId, id],
    );
    if (!row) return null;
    const { version, key_prefix, connections_present, tensions_present, desk_position, ...fields } = row;
    const relationships =
      connections_present || tensions_present
        ? await this.sql.query<{ kind: string; target_id: string; tension_kind: string; reason: string; computed_at: string }>(
            `SELECT kind, target_id, tension_kind, reason, computed_at FROM reading_relationships
             WHERE tenant_id = $1 AND source_id = $2 ORDER BY kind, position`,
            [this.tenantId, id],
          )
        : [];
    const manifest = present(fields);
    if (connections_present) {
      manifest.connections = relationships
        .filter((rel) => rel.kind === "connection")
        .map((rel) => ({ id: rel.target_id, reason: rel.reason }));
    }
    if (tensions_present) {
      manifest.tensions = relationships
        .filter((rel) => rel.kind === "tension")
        .map((rel) => ({ id: rel.target_id, kind: rel.tension_kind, reason: rel.reason, computed_at: rel.computed_at }));
    }
    return {
      keyPrefix: key_prefix as string,
      manifest: ManifestSchema.parse(manifest),
      version: version as string,
      ...(desk_position === null ? {} : { deskPosition: DeskPositionSchema.parse(desk_position) }),
    };
  }

  // /lookup's owner resolution: a pure SELECT, so it is safe (and tested)
  // inside a READ ONLY transaction. No claims, repairs or scans. The URL row
  // and its reading commit together, so there is no "initializing" outcome:
  // a row is owned, null is unclaimed.
  async findOwnerByUrl(url: string): Promise<UrlOwner | null> {
    const [row] = await this.sql.query<{ id: string; status: ManifestStatus }>(
      `SELECT r.id, r.status FROM reading_urls u
       JOIN readings r ON (r.tenant_id, r.id) = (u.tenant_id, u.reading_id)
       WHERE u.tenant_id = $1 AND u.url_hash = $2 AND r.url = $3`,
      [this.tenantId, await sha256Hex(url), url],
    );
    return row ? { id: row.id, status: row.status } : null;
  }

  // The keyed, batched form of findOwnerByUrl: the operator's reading-list
  // check asks "which of these URLs does this tenant already own?" about a few
  // hundred exported URLs at a time. Same join, same ownership meaning — a row
  // is owned, an absent one is unclaimed — so the two cannot drift.
  async ownersByUrls(urls: readonly string[]): Promise<Map<string, UrlOwner>> {
    const owners = new Map<string, UrlOwner>();
    if (urls.length === 0) return owners;
    const unique = [...new Set(urls)];
    const hashes = await Promise.all(unique.map((url) => sha256Hex(url)));
    const rows = await this.sql.query<{ url: string; id: string; status: ManifestStatus }>(
      `SELECT r.url, r.id, r.status FROM reading_urls u
       JOIN readings r ON (r.tenant_id, r.id) = (u.tenant_id, u.reading_id)
       WHERE u.tenant_id = $1 AND u.url_hash = ANY ($2::text[])`,
      [this.tenantId, hashes],
    );
    // Match on the URL itself, not only its hash, exactly as findOwnerByUrl
    // does: the hash selects the slot, the string proves it is this URL.
    const wanted = new Set(unique);
    for (const row of rows) {
      if (wanted.has(row.url)) owners.set(row.url, { id: row.id, status: row.status });
    }
    return owners;
  }

  // The current revision's keys are authoritative. A reading that was never
  // published has no revision: its content is wherever its latest capturing
  // attempt put it, or, for an imported reading no attempt has touched, at the
  // legacy spelling under the stored key_prefix.
  async contentKeys(id: string): Promise<ContentKeys | null> {
    const [row] = await this.sql.query<{
      key_prefix: string;
      content_type: string;
      content_status: Manifest["content_status"];
      raw_key: string | null;
      extracted_key: string | null;
      has_revision: boolean;
    }>(
      `SELECT r.key_prefix, r.content_type, r.content_status, v.raw_key, v.extracted_key,
              v.id IS NOT NULL AS has_revision
       FROM readings r
       LEFT JOIN reading_revisions v
         ON (v.tenant_id, v.reading_id, v.id) = (r.tenant_id, r.id, r.current_revision_id)
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [this.tenantId, id],
    );
    if (!row) return null;
    if (row.has_revision) {
      return { rawKey: row.raw_key!, extractedKey: row.extracted_key, contentType: row.content_type };
    }
    // Never published, but an attempt captured content under its revision keys.
    const [captured] = await this.sql.query<{ raw_key: string; extracted_key: string | null }>(
      `SELECT raw_key, extracted_key FROM reading_attempts
       WHERE tenant_id = $1 AND reading_id = $2 AND raw_key IS NOT NULL
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [this.tenantId, id],
    );
    if (captured) {
      return { rawKey: captured.raw_key, extractedKey: captured.extracted_key, contentType: row.content_type };
    }
    // The same rule the importer's revision row is spelled by: no extracted
    // object unless the content was captured.
    return { ...legacyContentKeys(row.key_prefix, row), contentType: row.content_type };
  }
}
