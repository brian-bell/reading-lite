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

export class OperatorCorpus {
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

  /** Escape hatch for a command with a query of its own; still tenant-scoped by the caller. */
  get query(): SqlQuery["query"] {
    return this.sql.query.bind(this.sql);
  }
}

export function operatorCorpusFor(sql: Sql, tenant: OperatorTenant): OperatorCorpus {
  return new OperatorCorpus(sql, requirePgTenant(tenant));
}
