// The one manifest-to-rows mapping (ADR 0005), shared by the runtime writer,
// seed:local, the parity suite and the #348 importer. Pure: no I/O and no Node
// imports. `writeReadingRows` is the whole-reading replace the seeders and the
// importer use; the runtime publishes through the per-table inserts instead,
// because a replace would cascade away the reading's attempts, jobs and URL
// ownership.
//
// A manifest cannot say whether it owns its URL, so the caller decides:
// `ownsUrl: false` emits no reading_urls row (a failed orphan duplicate).
// Rank duplicates with `compareUrlOwnership`, re-exported here, so importers
// do not fork the ready > pending > failed, then newest, rule.

import type { Manifest } from "../../../schemas/manifest";
import type { SqlQuery } from "../../db/sql";
import { vectorLiteral } from "../../db/sql";
import { r2KeyLayout, rawExtFromContentType } from "../layout";

export { compareUrlOwnership } from "../list-index";

export interface ManifestRowsInput {
  tenantId: string;
  keyPrefix: string;
  ownsUrl: boolean;
  // The reading's 1536-dimension vector, when the caller has one. Only ready
  // readings are searchable, so it is ignored (and noted) for other statuses.
  embedding?: readonly number[];
  // The runtime publishes under the attempt's id and its immutable revision
  // keys. Omitted by the seeders and the importer, whose content sits at the
  // legacy spelling under key_prefix.
  revision?: { id: string; rawKey: string; extractedKey: string | null };
}

export interface ReadingRow {
  tenant_id: string;
  id: string;
  key_prefix: string;
  url: string;
  url_hash: string;
  status: Manifest["status"];
  source_type: string | null;
  title: string | null;
  tldr: string | null;
  tags: string[] | null;
  keywords: string[] | null;
  people: string[] | null;
  orgs: string[] | null;
  novelty_verdict: string | null;
  source_date: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
  content_type: string;
  content_status: string;
  content_bytes: number;
  extracted_bytes: number | null;
  content_sha256: string;
  error: unknown | null;
  similarity: unknown | null;
  enrichment_degradation: unknown | null;
  active_attempt: unknown | null;
  last_attempt: unknown | null;
  current_revision_id: string | null;
}

export interface RevisionRow {
  id: string;
  raw_key: string;
  extracted_key: string | null;
  content_type: string;
  content_status: string;
  content_bytes: number;
  extracted_bytes: number | null;
  content_sha256: string;
  summary_markdown: string | null;
  usage: unknown | null;
  connections_present: boolean;
  tensions_present: boolean;
  connections_computed_at: string | null;
  connections_neighbourhood_ids: string[] | null;
  tensions_judged: unknown | null;
  published_at: string;
}

export interface RelationshipRow {
  kind: "connection" | "tension";
  target_id: string;
  position: number;
  tension_kind: string | null;
  reason: string;
  computed_at: string | null;
}

export interface ReadingRows {
  reading: ReadingRow;
  ownsUrl: boolean;
  revision: RevisionRow | null;
  relationships: RelationshipRow[];
  embedding: readonly number[] | null;
  // What the rows could not carry. The importer reports these; an empty list
  // means the manifest round-trips exactly.
  notes: string[];
}

// Published-only manifest fields. They live on the revision, which only a
// ready reading has.
const PUBLISHED_FIELDS = [
  "summary_markdown",
  "usage",
  "connections",
  "connections_computed_at",
  "connections_neighbourhood_ids",
  "tensions",
  "tensions_judged",
] as const;

export function manifestToRows(manifest: Manifest, input: ManifestRowsInput): ReadingRows {
  const notes: string[] = [];
  const layout = r2KeyLayout("");
  const published = manifest.status === "ready";
  const revisionId = input.revision?.id ?? `rev_${manifest.id}`;

  if (manifest.preserve_ready_manifest !== undefined) {
    notes.push("preserve_ready_manifest dropped: revisions replace it");
  }
  if (!published) {
    for (const field of PUBLISHED_FIELDS) {
      if (manifest[field] !== undefined) notes.push(`${field} dropped: ${manifest.status} reading has no revision`);
    }
  }

  const relationships: RelationshipRow[] = [];
  if (published) {
    const seen = new Set<string>();
    const push = (row: Omit<RelationshipRow, "position">, position: number) => {
      const key = `${row.kind}:${row.target_id}`;
      if (seen.has(key)) {
        notes.push(`duplicate ${row.kind} target ${row.target_id} dropped: first occurrence kept`);
        return;
      }
      seen.add(key);
      relationships.push({ ...row, position });
    };
    (manifest.connections ?? []).forEach((connection, position) =>
      push({ kind: "connection", target_id: connection.id, tension_kind: null, reason: connection.reason, computed_at: null }, position),
    );
    (manifest.tensions ?? []).forEach((tension, position) =>
      push(
        { kind: "tension", target_id: tension.id, tension_kind: tension.kind, reason: tension.reason, computed_at: tension.computed_at },
        position,
      ),
    );
  }

  let embedding = input.embedding ?? null;
  if (embedding !== null && !published) {
    notes.push(`embedding dropped: ${manifest.status} reading is not searchable`);
    embedding = null;
  }

  return {
    reading: {
      tenant_id: input.tenantId,
      id: manifest.id,
      key_prefix: input.keyPrefix,
      url: manifest.url,
      url_hash: manifest.url_hash,
      status: manifest.status,
      source_type: manifest.source_type ?? null,
      title: manifest.title ?? null,
      tldr: manifest.tldr ?? null,
      tags: manifest.tags ?? null,
      keywords: manifest.keywords ?? null,
      people: manifest.people ?? null,
      orgs: manifest.orgs ?? null,
      novelty_verdict: manifest.novelty_verdict ?? null,
      source_date: manifest.source_date ?? null,
      fetched_at: manifest.fetched_at ?? null,
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
      content_type: manifest.content_type,
      content_status: manifest.content_status,
      content_bytes: manifest.content_bytes,
      extracted_bytes: manifest.extracted_bytes ?? null,
      content_sha256: manifest.content_sha256,
      error: manifest.error ?? null,
      similarity: manifest.similarity ?? null,
      enrichment_degradation: manifest.enrichment_degradation ?? null,
      active_attempt: manifest.active_attempt ?? null,
      last_attempt: manifest.last_attempt ?? null,
      current_revision_id: published ? revisionId : null,
    },
    ownsUrl: input.ownsUrl,
    revision: published
      ? {
          id: revisionId,
          // Relative keys, spelled the way /content/raw finds the object today.
          raw_key: input.revision?.rawKey ?? layout.rawKey(input.keyPrefix, rawExtFromContentType(manifest.content_type)),
          extracted_key: input.revision
            ? input.revision.extractedKey
            : manifest.content_status === "captured" ? layout.extractedKey(input.keyPrefix) : null,
          content_type: manifest.content_type,
          content_status: manifest.content_status,
          content_bytes: manifest.content_bytes,
          extracted_bytes: manifest.extracted_bytes ?? null,
          content_sha256: manifest.content_sha256,
          summary_markdown: manifest.summary_markdown ?? null,
          usage: manifest.usage ?? null,
          connections_present: manifest.connections !== undefined,
          tensions_present: manifest.tensions !== undefined,
          connections_computed_at: manifest.connections_computed_at ?? null,
          connections_neighbourhood_ids: manifest.connections_neighbourhood_ids ?? null,
          tensions_judged: manifest.tensions_judged ?? null,
          published_at: manifest.updated_at,
        }
      : null,
    relationships,
    embedding,
    notes,
  };
}

// pg turns a JS array parameter into a PostgreSQL array, so JSONB values are
// always passed as text.
export const json = (value: unknown | null): string | null => (value === null ? null : JSON.stringify(value));

// Replaces one reading's rows. Call inside a transaction: the
// readings -> reading_revisions foreign key is deferred to commit.
export async function writeReadingRows(tx: SqlQuery, rows: ReadingRows): Promise<void> {
  const r = rows.reading;
  await tx.query("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [r.tenant_id, r.id]);
  await insertReading(tx, r);
  if (rows.ownsUrl) {
    await tx.query("INSERT INTO reading_urls (tenant_id, url_hash, reading_id) VALUES ($1, $2, $3)", [
      r.tenant_id, r.url_hash, r.id,
    ]);
  }
  if (rows.revision) await insertRevision(tx, r.tenant_id, r.id, rows.revision);
  await insertRelationships(tx, r.tenant_id, r.id, rows.relationships);
  if (rows.embedding) await upsertEmbedding(tx, r.tenant_id, r.id, rows.embedding);
}

export async function insertReading(tx: SqlQuery, r: ReadingRow): Promise<void> {
  await tx.query(
    `INSERT INTO readings (
       tenant_id, id, key_prefix, url, url_hash, status, source_type, title, tldr,
       tags, keywords, people, orgs, novelty_verdict, source_date, fetched_at,
       created_at, updated_at, content_type, content_status, content_bytes,
       extracted_bytes, content_sha256, error, similarity, enrichment_degradation,
       active_attempt, last_attempt, current_revision_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26::jsonb, $27::jsonb,
       $28::jsonb, $29
     )`,
    [
      r.tenant_id, r.id, r.key_prefix, r.url, r.url_hash, r.status, r.source_type, r.title, r.tldr,
      r.tags, r.keywords, r.people, r.orgs, r.novelty_verdict, r.source_date, r.fetched_at,
      r.created_at, r.updated_at, r.content_type, r.content_status, r.content_bytes,
      r.extracted_bytes, r.content_sha256, json(r.error), json(r.similarity), json(r.enrichment_degradation),
      json(r.active_attempt), json(r.last_attempt), r.current_revision_id,
    ],
  );
}

export async function insertRevision(tx: SqlQuery, tenantId: string, readingId: string, v: RevisionRow): Promise<void> {
  await tx.query(
    `INSERT INTO reading_revisions (
       tenant_id, reading_id, id, raw_key, extracted_key, content_type, content_status,
       content_bytes, extracted_bytes, content_sha256, summary_markdown, usage,
       connections_present, tensions_present, connections_computed_at,
       connections_neighbourhood_ids, tensions_judged, published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18)`,
    [
      tenantId, readingId, v.id, v.raw_key, v.extracted_key, v.content_type, v.content_status,
      v.content_bytes, v.extracted_bytes, v.content_sha256, v.summary_markdown, json(v.usage),
      v.connections_present, v.tensions_present, v.connections_computed_at,
      v.connections_neighbourhood_ids, json(v.tensions_judged), v.published_at,
    ],
  );
}

export async function insertRelationships(
  tx: SqlQuery,
  tenantId: string,
  sourceId: string,
  relationships: readonly RelationshipRow[],
): Promise<void> {
  for (const rel of relationships) {
    await tx.query(
      `INSERT INTO reading_relationships (tenant_id, source_id, kind, target_id, position, tension_kind, reason, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, sourceId, rel.kind, rel.target_id, rel.position, rel.tension_kind, rel.reason, rel.computed_at],
    );
  }
}

export async function upsertEmbedding(
  tx: SqlQuery,
  tenantId: string,
  readingId: string,
  embedding: readonly number[],
): Promise<void> {
  await tx.query(
    `INSERT INTO reading_embeddings (tenant_id, reading_id, embedding) VALUES ($1, $2, $3::vector)
     ON CONFLICT (tenant_id, reading_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [tenantId, readingId, vectorLiteral(embedding)],
  );
}
