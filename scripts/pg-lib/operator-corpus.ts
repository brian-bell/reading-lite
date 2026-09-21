// The operator's view of the corpus, over PostgreSQL (reading-lite-gh347.4.7).
//
// Every read here delegates to PgReadingStore, the same store the Worker reads
// through. That is deliberate and it is the point of the module: if the
// operator carried its own copy of "what a reading is", the two could disagree
// about status, about which revision is current, or about where a reading's
// bytes live — and the operator's answer is the one an irreversible delete is
// planned from. The only queries written here are ones that are not about a
// reading at all: the attempt event log, and the DELETEs.
//
// `ListIndexItem` is a superset of the shapes the corpus tooling already ranks
// and classifies over (corpus-lib/types.ts `ListItem`, corpus-lib/sweep.ts
// `SweepItem`), so the pure planners take these rows unchanged. Nothing
// re-maps them field by field, which is what would let a field quietly go
// missing.

import type { TenantContext } from "../../src/control-plane/ids";
import { parseTenantId } from "../../src/control-plane/ids";
import type { Sql, SqlQuery } from "../../src/modules/db/sql";
import {
  pgReadingStoreFor,
  type ContentKeys,
  type PgReadingStore,
} from "../../src/modules/stores/postgres/reading-store";
import type { ListIndexItem } from "../../src/schemas/api";
import { UsageError } from "../ops-lib/contract";
import { operatorTenantSelector, type OperatorTenant } from "../corpus-lib/tenant";

/**
 * The tenant whose rows a PostgreSQL read addresses.
 *
 * `--tenant global` selects the pre-tenant R2 layout — an empty key root — and
 * no `readings` row can carry it: every row is `WHERE tenant_id = $1` and a
 * tenant id is a user id. Rather than resolve it to something that returns
 * zero rows and reads as "an empty corpus", it is refused outright. The R2-only
 * commands that still address retained pre-tenant objects keep accepting it.
 */
export function requireTenantRows(tenant: OperatorTenant): TenantContext {
  if (tenant.kind === "global") {
    throw new UsageError(
      "--tenant global addresses the pre-tenant R2 layout, which has no rows in PostgreSQL. " +
        "Pass the tenant id (usr_…) whose corpus you mean; production's is /api/whoami's tenant_id.",
    );
  }
  const tenantId = parseTenantId(tenant.tenantId);
  if (!tenantId) throw new UsageError(`malformed tenant selector: ${operatorTenantSelector(tenant)}`);
  return { tenantId };
}

export function operatorReadings(sql: SqlQuery, tenant: TenantContext): PgReadingStore {
  return pgReadingStoreFor(sql as Sql, tenant);
}

/** Every reading in the tenant's corpus, newest first. */
export function listItems(store: PgReadingStore): Promise<ListIndexItem[]> {
  return store.allListItems();
}

export type { ContentKeys };

/**
 * The R2 content a drop has to take with it.
 *
 * Resolved through the store, which covers all three tiers: the current
 * revision's keys, the latest capturing attempt's keys for a reading that was
 * never published, and the legacy spelling under the stored `key_prefix` for
 * an imported reading no attempt has touched. Deriving these from the revision
 * alone silently strands the third tier's bytes — the rows cascade, R2 keeps
 * the objects, and nothing reports it.
 *
 * Read BEFORE the row is deleted. Afterwards there is nothing left to resolve
 * them from.
 */
export async function contentKeysFor(
  sql: SqlQuery,
  store: PgReadingStore,
  tenantId: string,
  id: string,
): Promise<string[]> {
  const keys = new Set<string>();
  const add = (raw: string | null, extracted: string | null): void => {
    if (raw) keys.add(raw);
    if (extracted) keys.add(extracted);
  };

  // The three tiers, from the store, so the operator and the Worker agree on
  // where a reading's current bytes are.
  const current = await store.contentKeys(id);
  if (current === null) return [];
  add(current.rawKey, current.extractedKey);

  // Then every OTHER revision and attempt. `reading_revisions` accumulates one
  // row per publish (PgReadingWriter.publish inserts, never replaces), and each
  // publish writes under its own attempt's immutable revision keys. The tiers
  // above name only the current pair, so a reading published twice would leave
  // its first revision's objects in the bucket with nothing able to name them
  // again once the row cascade removed the revision. The Worker's own purge
  // avoids this by deleting the whole key_prefix (reading-purge.ts); the
  // operator has no prefix delete through the wrangler CLI, so it asks the
  // database for every key instead, which is the same completeness by a
  // different route.
  const rows = await sql.query<{ raw_key: string | null; extracted_key: string | null }>(
    `SELECT raw_key, extracted_key FROM reading_revisions WHERE tenant_id = $1 AND reading_id = $2
     UNION
     SELECT raw_key, extracted_key FROM reading_attempts
       WHERE tenant_id = $1 AND reading_id = $2 AND raw_key IS NOT NULL`,
    [tenantId, id],
  );
  for (const row of rows) add(row.raw_key, row.extracted_key);

  return [...keys];
}

/**
 * Splits resolved content keys into those genuinely under the reading's own
 * id-scoped prefix and those that are not.
 *
 * The keys above come out of the database, so unlike the old layout-derived
 * spelling they are not bounded by construction: a row written wrong — by a
 * bad importer, a hand repair, or an absolute rather than relative key — would
 * otherwise aim an operator's delete at an arbitrary object under the tenant
 * root, with the command reporting success. Every spelling the layout produces
 * is `{key_prefix}/…` (src/modules/stores/layout.ts), so anything else is a
 * corrupt row and the caller must refuse rather than delete it.
 */
export function partitionKeysByPrefix(
  keys: readonly string[],
  keyPrefix: string,
): { within: string[]; foreign: string[] } {
  const within: string[] = [];
  const foreign: string[] = [];
  for (const key of keys) {
    (key.startsWith(`${keyPrefix}/`) ? within : foreign).push(key);
  }
  return { within, foreign };
}

/**
 * Deletes the reading row. `reading_urls`, `reading_revisions`,
 * `reading_attempts`, `reading_relationships` (source side) and
 * `reading_embeddings` all cascade from it (db/migrations/0001, 0002), so the
 * by-url claim, the summary, the attempts and the embedding go with it in one
 * statement. Returns the number of rows deleted: zero means a sibling won.
 */
export function deleteReading(sql: SqlQuery, tenantId: string, id: string): Promise<number> {
  return sql.execute("DELETE FROM readings WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
}

/**
 * Deletes every relationship naming `targetId` as its target.
 *
 * `reading_relationships` has a foreign key on the source only, so deleting a
 * reading leaves every inbound row that cites it. This is the whole of what
 * `corpus purge-connections` used to do by rewriting every manifest under a
 * compare-and-set loop.
 */
export function deleteInboundRelationships(
  sql: SqlQuery,
  tenantId: string,
  targetId: string,
): Promise<number> {
  return sql.execute("DELETE FROM reading_relationships WHERE tenant_id = $1 AND target_id = $2", [
    tenantId,
    targetId,
  ]);
}

/**
 * Whether the corpus holds an embedding for this reading.
 *
 * Asked rather than inferred from status: a ready reading normally has one,
 * but nothing in the schema requires it, and `corpus sweep`'s post-sweep
 * warning is only worth printing if it is exact.
 */
export async function hasEmbedding(
  sql: SqlQuery,
  tenantId: string,
  readingId: string,
): Promise<boolean> {
  const rows = await sql.query(
    "SELECT 1 FROM reading_embeddings WHERE tenant_id = $1 AND reading_id = $2",
    [tenantId, readingId],
  );
  return rows.length > 0;
}

/**
 * The stage the latest attempt actually reached, for `corpus audit --deep`.
 *
 * Not a reading query: it reads the attempt's ordered event log, which the
 * Worker's store deliberately does not expose because nothing serving a
 * request needs it. It is the row-shaped replacement for reading the attempt
 * JSON out of R2.
 */
export async function latestAttemptStage(
  sql: SqlQuery,
  tenantId: string,
  readingId: string,
): Promise<string | null> {
  const [row] = await sql.query<{ stage: string | null; status: string | null; events: unknown }>(
    `SELECT stage, status, events FROM reading_attempts
     WHERE tenant_id = $1 AND reading_id = $2
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [tenantId, readingId],
  );
  if (!row) return null;
  const events = Array.isArray(row.events) ? (row.events as Record<string, unknown>[]) : [];
  const last = events[events.length - 1];
  const stage = (last?.stage as string | undefined) ?? row.stage ?? undefined;
  if (stage === undefined) return null;
  const status = (last?.status as string | undefined) ?? row.status ?? "?";
  return `${stage}/${status}`;
}
