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
//
// The writes below (reading-lite-gh347.4.1) are the refresh passes' half of the
// module, and they follow the same rule from the other side: the relationship
// replace is the Worker's own `PgReadingWriter.replacePublishedSetIf`, not an
// operator copy of it. Two writers to `reading_relationships` with different
// lock disciplines is exactly the hazard one shared writer removes. Only the
// neighbour snapshot is written here, because it is a single column and has no
// runtime writer to borrow.

import type { TenantContext } from "../../src/control-plane/ids";
import { parseTenantId } from "../../src/control-plane/ids";
import type { Sql, SqlQuery } from "../../src/modules/db/sql";
import {
  pgReadingStoreFor,
  type ContentKeys,
  type PgReadingStore,
} from "../../src/modules/stores/postgres/reading-store";
import {
  pgReadingWriterFor,
  type PublishedReplacement,
  type ReplaceSetOutcome,
  type SkippedTarget,
} from "../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../src/modules/stores/postgres/similarity-store";
import type { SimilarityMatch } from "../../src/modules/stores/similarity";
import type { Manifest, SimilaritySnapshot } from "../../src/schemas/manifest";
import type { ListIndexItem } from "../../src/schemas/api";
import { sha256Hex } from "../../src/services";
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

export type { PublishedReplacement, ReplaceSetOutcome, SkippedTarget };

/**
 * A reading's exact neighbourhood: the pgvector cosine scan over this tenant's
 * rows, self included, as `queryByVectorId` returns it.
 *
 * `null` when the reading owns no embedding, which is a different answer from
 * "no neighbours" and the one the refresh pass reports as unmeasurable.
 *
 * The scan is exact rather than approximate (ADR 0005), so an operator pass
 * and the Worker see the same neighbourhood for the same corpus — a refresh
 * that measured against a different index from the one serving reads would
 * write drift nobody could reproduce.
 */
export function neighboursOf(
  sql: SqlQuery,
  tenant: TenantContext,
  id: string,
  topK: number,
): Promise<SimilarityMatch[] | null> {
  return pgSimilarityStoreFor(sql as Sql, tenant).queryByVectorId(id, topK);
}

/**
 * Writes one reading's measured `similarity` snapshot and nothing else.
 *
 * Deliberately not `updated_at`: no content changed, and bumping it would
 * misreport the reading as freshly written to everything that orders by it —
 * the list the SPA serves, and the refresh pass's own incremental scope, which
 * would then re-measure the reading it just measured, every night, forever.
 * This is the one-field discipline the retired manifest backfill carried,
 * expressed as a column.
 *
 * Returns false when no row was updated: the reading was purged while the pass
 * was measuring it.
 */
export async function setSimilarity(
  sql: SqlQuery,
  tenantId: string,
  id: string,
  similarity: SimilaritySnapshot,
): Promise<boolean> {
  const updated = await sql.execute(
    "UPDATE readings SET similarity = $3::jsonb WHERE tenant_id = $1 AND id = $2",
    [tenantId, id, JSON.stringify(similarity)],
  );
  return updated > 0;
}

/**
 * The version of a manifest an operator pass compares against, standing in for
 * the ETag the manifest-era compare-and-set witnessed.
 *
 * The same content hash `src/relationship-judge.ts` uses for the hosted judge,
 * so the two agree on what "changed since I read it" means. A pass reads a
 * manifest, judges from it, and hands this predicate to the replace, which
 * re-reads under the row lock: identical hash, identical manifest.
 */
export function manifestVersion(manifest: Manifest): Promise<string> {
  return sha256Hex(JSON.stringify(manifest));
}

/**
 * Replaces the judged relationship set of one or more readings, in one
 * transaction, through the Worker's own writer.
 *
 * A judged set is rows in `reading_relationships` AND the flags on the
 * reading's current revision (`connections_present`, `tensions_present`,
 * `connections_computed_at`, `connections_neighbourhood_ids`,
 * `tensions_judged`). The flags are load-bearing: relationship rows cannot
 * tell an absent array from an empty one, so a set written as rows without its
 * flag reads back as never computed. The writer writes both halves or neither.
 *
 * Pass both halves of a directional tension as one call. Two calls are two
 * transactions, and a crash between them leaves a corpus that disagrees with
 * itself about a pair it judged once.
 */
export function replaceRelationships(
  sql: SqlQuery,
  tenant: TenantContext,
  entries: readonly PublishedReplacement[],
): Promise<ReplaceSetOutcome> {
  return pgReadingWriterFor(sql as Sql, tenant).replacePublishedSetIf(entries);
}

/**
 * The tenant's refresh run marker, unparsed. `null` only when there is none.
 *
 * Unparsed on purpose: scripts/corpus-lib/refresh-scope.ts owns the marker's
 * shape and versions it, and it is the one that decides whether a stored
 * marker is usable. Parsing here would put that decision in two places, and
 * the pass's answer to an unusable marker — sweep — is not this module's to
 * make.
 */
export async function readRefreshState(sql: SqlQuery, tenantId: string): Promise<unknown | null> {
  const [row] = await sql.query<{ state: unknown }>(
    "SELECT state FROM corpus_refresh_state WHERE tenant_id = $1",
    [tenantId],
  );
  return row?.state ?? null;
}

/**
 * Stores the run marker for the next pass to scope against.
 *
 * One row per tenant, replaced whole: the marker is a statement about one
 * complete pass, and merging two passes' fields would describe a pass that
 * never ran.
 *
 * Hold the active user's row FOR SHARE through the upsert, like the runtime
 * reading writer. Account deletion and teardown take a conflicting user lock:
 * they either remove this marker after it commits, or this write observes an
 * inactive/missing user and refuses. The marker has no users foreign key.
 */
export async function writeRefreshState(
  sql: Sql,
  tenantId: string,
  state: unknown,
  now: string,
): Promise<void> {
  await sql.transaction(async (tx) => {
    const [user] = await tx.query<{ status: string }>(
      "SELECT status FROM users WHERE id = $1 FOR SHARE",
      [tenantId],
    );
    if (user?.status !== "active") {
      throw new Error("cannot write refresh state: account is not active");
    }
    await tx.query(
      `INSERT INTO corpus_refresh_state (tenant_id, state, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [tenantId, JSON.stringify(state), now],
    );
  });
}
