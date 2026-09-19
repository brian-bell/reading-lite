// PostgreSQL read store for readings (ADR 0005). Returns the same
// ListIndexItem and Manifest shapes as ReadingStore, parsed with zod at the
// seam, so the router's contract did not change when it switched over.
//
// Every query is `WHERE tenant_id = $1`, and the only constructor validates
// the tenant id exactly as tenantKeyRoot does. Captured content stays in R2:
// this store hands out relative keys and ContentStore reads them.

import type { TenantContext } from "../../../control-plane/ids";
import { parseTenantId } from "../../../control-plane/ids";
import { ListIndexItemSchema, type ListIndexItem } from "../../../schemas/api";
import { ManifestSchema, type Manifest, type ManifestStatus } from "../../../schemas/manifest";
import { sha256Hex } from "../../../services";
import type { Sql, SqlQuery, SqlRow } from "../../db/sql";
import { r2KeyLayout, rawExtFromContentType } from "../layout";
import type { ListManifestsParams, ListManifestsResult } from "../list-index";

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

export interface ContentKeys {
  // Relative R2 keys; compose the tenant root through r2KeyLayout to read.
  rawKey: string;
  extractedKey: string | null;
  contentType: string;
}

const LIST_COLUMNS = `id, key_prefix, url, title, tldr, tags, keywords, status, novelty_verdict,
  similarity, source_date, created_at, updated_at, error, active_attempt, last_attempt,
  enrichment_degradation`;

// Today's semantics exactly (list-index.ts): a case-insensitive substring over
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
    const [count] = await this.sql.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM readings WHERE ${LIST_FILTER}`,
      [this.tenantId, q, tag],
    );
    // The id tiebreak is deliberate: today's sort is stable on created_at alone.
    const rows = await this.sql.query(
      `SELECT ${LIST_COLUMNS} FROM readings WHERE ${LIST_FILTER}
       ORDER BY created_at DESC, id DESC OFFSET $4 LIMIT $5`,
      [this.tenantId, q, tag, params.offset, params.limit],
    );
    return {
      readings: rows.map((row) => ListIndexItemSchema.parse(present(row))),
      total_filtered: count!.total,
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

  // Keyed replacement for the whole-index read behind relationship_targets.
  async relationshipTargets(ids: readonly string[]): Promise<ListIndexItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql.query(
      `SELECT ${LIST_COLUMNS} FROM readings WHERE tenant_id = $1 AND id = ANY ($2::text[])`,
      [this.tenantId, [...ids]],
    );
    return rows.map((row) => ListIndexItemSchema.parse(present(row)));
  }

  async loadReadingById(id: string): Promise<{ keyPrefix: string; manifest: Manifest } | null> {
    const [row] = await this.sql.query(
      `SELECT r.id, r.key_prefix, r.url, r.url_hash, r.source_type, r.status, r.error,
              r.active_attempt, r.last_attempt, r.title, r.tldr, r.tags, r.keywords, r.people,
              r.orgs, r.novelty_verdict, r.similarity, r.content_type, r.content_status,
              r.content_bytes, r.extracted_bytes, r.content_sha256, r.enrichment_degradation,
              r.source_date, r.fetched_at, r.created_at, r.updated_at,
              v.summary_markdown, v.usage, v.connections_computed_at,
              v.connections_neighbourhood_ids, v.tensions_judged,
              v.connections_present, v.tensions_present
       FROM readings r
       LEFT JOIN reading_revisions v
         ON (v.tenant_id, v.reading_id, v.id) = (r.tenant_id, r.id, r.current_revision_id)
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [this.tenantId, id],
    );
    if (!row) return null;
    const { key_prefix, connections_present, tensions_present, ...fields } = row;
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
    return { keyPrefix: key_prefix as string, manifest: ManifestSchema.parse(manifest) };
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

  // The current revision's keys are authoritative. A reading that was never
  // published has no revision: its content is wherever its latest capturing
  // attempt put it, or, for an imported reading no attempt has touched, at the
  // legacy spelling under the stored key_prefix.
  async contentKeys(id: string): Promise<ContentKeys | null> {
    const [row] = await this.sql.query<{
      key_prefix: string;
      content_type: string;
      raw_key: string | null;
      extracted_key: string | null;
      has_revision: boolean;
    }>(
      `SELECT r.key_prefix, r.content_type, v.raw_key, v.extracted_key, v.id IS NOT NULL AS has_revision
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
    const layout = r2KeyLayout("");
    return {
      rawKey: layout.rawKey(row.key_prefix, rawExtFromContentType(row.content_type)),
      extractedKey: layout.extractedKey(row.key_prefix),
      contentType: row.content_type,
    };
  }
}
