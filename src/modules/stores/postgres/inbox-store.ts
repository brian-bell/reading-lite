// PostgreSQL store for the tenant's Markdown inbox (reading-lite-gh423,
// db/migrations/0008). An inbox item is Markdown staged for review; it has no
// reading, URL claim, attempt, job or embedding, and nothing here touches the
// reading tables. Promote (src/inbox/promote.ts) turns an item into a reading
// through ReadingIntake.importMarkdown and then deletes it with
// deleteIfUnchanged.
//
// Every query is `WHERE tenant_id = $1`, and rows are parsed with zod at the
// seam, as in the reading store.
//
// Stage is the only verb that creates a row, so it is the only one that takes
// the tenant fence: `users` FOR SHARE with `active` required, in the same
// transaction as the write, exactly as `claimUrl` does. `DELETE /api/account`
// therefore waits behind a stage in flight, and every later one writes
// nothing. The shared lock does not serialize two stages, so the item cap is
// counted under a per-tenant advisory lock taken after it; without that, two
// stages at 199 items would both count 199 and both insert.

import { fromSql, lockKey } from "../../../control-plane/db";
import type { TenantContext } from "../../../control-plane/ids";
import {
  INBOX_ITEM_CAP,
  InboxItemMetaSchema,
  InboxItemSchema,
  type InboxItem,
  type InboxItemMeta,
} from "../../../schemas/api";
import { sha256Hex } from "../../../services";
import type { Sql, SqlQuery, SqlRow } from "../../db/sql";
import { pgTenantId } from "./reading-store";

export function pgInboxStoreFor(
  sql: Sql,
  tenant: TenantContext,
  clock: { now: () => string; newId: () => string },
): PgInboxStore {
  return new PgInboxStore(sql, pgTenantId(tenant), clock);
}

export type InboxStageResult =
  | { kind: "staged"; item: InboxItemMeta; replaced: boolean }
  | { kind: "inbox_full" }
  | { kind: "tenant_inactive" };

export type InboxDeleteResult = "deleted" | "changed" | "missing";

const META_COLUMNS = `id, url, title, octet_length(markdown) AS markdown_bytes, created_at, updated_at`;

function parseMeta(row: SqlRow): InboxItemMeta {
  return InboxItemMetaSchema.parse(row);
}

export class PgInboxStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
    private readonly clock: { now: () => string; newId: () => string },
  ) {}

  /**
   * Creates the item for `url`, or overwrites the one already staged for it.
   *
   * An overwrite keeps the id and `created_at`, replaces the Markdown and the
   * title (an omitted title clears it), and moves `updated_at` strictly
   * forward even within one millisecond, so promote's delete-if-unchanged
   * can always tell a re-stage from the version it loaded. `updated_at` is
   * written from the injected clock, never SQL `now()`, so the value a reader
   * loads compares equal to the stored one.
   */
  async stage(input: { url: string; markdown: string; title?: string }): Promise<InboxStageResult> {
    const urlHash = await sha256Hex(input.url);
    const now = this.clock.now();
    return this.sql.transaction(async (tx) => {
      const [user] = await tx.query<{ status: string }>(
        "SELECT status FROM users WHERE id = $1 FOR SHARE",
        [this.tenantId],
      );
      // A missing row is inactive too: teardown deletes `users` last, and
      // inbox_items has no foreign key to it, so this check is what keeps an
      // item from outliving its account.
      if (user?.status !== "active") return { kind: "tenant_inactive" } as const;
      await lockKey(fromSql(tx), `inbox:${this.tenantId}`);

      const [existing] = await tx.query<{ id: string }>(
        "SELECT id FROM inbox_items WHERE tenant_id = $1 AND url_hash = $2",
        [this.tenantId, urlHash],
      );
      if (!existing) {
        const [counted] = await tx.query<{ items: number }>(
          "SELECT count(*)::int AS items FROM inbox_items WHERE tenant_id = $1",
          [this.tenantId],
        );
        if (counted!.items >= INBOX_ITEM_CAP) return { kind: "inbox_full" } as const;
      }
      // `replaced` comes from the upsert, not the SELECT above: discard does not
      // take the advisory lock, so the row it saw can be gone by now, and then
      // this is a new item with a new id.
      const newId = `in_${this.clock.newId()}`;
      const [row] = await tx.query(
        `INSERT INTO inbox_items (tenant_id, id, url, url_hash, title, markdown, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (tenant_id, url_hash) DO UPDATE SET
           url = EXCLUDED.url,
           title = EXCLUDED.title,
           markdown = EXCLUDED.markdown,
           updated_at = GREATEST(EXCLUDED.updated_at, inbox_items.updated_at + interval '1 millisecond')
         RETURNING ${META_COLUMNS}`,
        [this.tenantId, newId, input.url, urlHash, input.title ?? null, input.markdown, now],
      );
      const item = parseMeta(row!);
      return { kind: "staged", item, replaced: item.id !== newId } as const;
    });
  }

  /** Every item, metadata only, most recently staged first. */
  async list(): Promise<InboxItemMeta[]> {
    const rows = await this.sql.query(
      `SELECT ${META_COLUMNS} FROM inbox_items WHERE tenant_id = $1 ORDER BY updated_at DESC, id DESC`,
      [this.tenantId],
    );
    return rows.map(parseMeta);
  }

  async get(id: string): Promise<InboxItem | null> {
    const [row] = await this.sql.query(
      `SELECT ${META_COLUMNS}, markdown FROM inbox_items WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id],
    );
    return row ? InboxItemSchema.parse(row) : null;
  }

  /** Deletes the item whatever its version. False when there was none. */
  async discard(id: string): Promise<boolean> {
    return (await this.sql.execute("DELETE FROM inbox_items WHERE tenant_id = $1 AND id = $2", [this.tenantId, id])) > 0;
  }

  /**
   * Deletes the item staged for `url`, if any. Stage calls it when a ready or
   * pending reading now owns the URL: the item could only ever promote into
   * that reading, so it is not left in the inbox as stale text.
   */
  async discardUrl(url: string): Promise<boolean> {
    return (
      (await this.sql.execute("DELETE FROM inbox_items WHERE tenant_id = $1 AND url_hash = $2", [
        this.tenantId,
        await sha256Hex(url),
      ])) > 0
    );
  }

  /**
   * Deletes the item only if it is still the version loaded at `updatedAt`.
   * A re-stage in between moved `updated_at`, and the newer Markdown stays
   * (`changed`) for a person to review.
   */
  async deleteIfUnchanged(id: string, updatedAt: string): Promise<InboxDeleteResult> {
    const deleted = await this.sql.execute(
      "DELETE FROM inbox_items WHERE tenant_id = $1 AND id = $2 AND updated_at = $3",
      [this.tenantId, id, updatedAt],
    );
    if (deleted > 0) return "deleted";
    const [row] = await this.sql.query("SELECT 1 FROM inbox_items WHERE tenant_id = $1 AND id = $2", [this.tenantId, id]);
    return row ? "changed" : "missing";
  }
}

/**
 * Every inbox item a tenant owns. The account wipe runs it in the transaction
 * that deletes the tenant's reading rows, at both of its call sites, so the
 * two cannot drift apart on the tenant predicate.
 */
export async function deleteTenantInboxItems(tx: SqlQuery, tenantId: string): Promise<number> {
  return tx.execute("DELETE FROM inbox_items WHERE tenant_id = $1", [tenantId]);
}
