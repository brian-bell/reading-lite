// PostgreSQL store for the desk (reading-lite-kl7y.6, db/migrations/0012):
// up to DESK_CAP readings set aside to read next, in position order.
//
// Every write is one transaction that takes the tenant's `desk:` advisory lock
// first, since the row being added may not exist yet, then locks the reading
// row FOR SHARE. FOR SHARE sets the row's xmax, never its xmin, so a toggle
// does not change the version startAttempt compares, and nothing here writes
// the readings row. Under the lock the tenant's rows are renumbered 1..n in
// position order, which closes the gap a purge's cascade left.
//
// No tenant fence is needed: a desk row cannot outlive its reading (the
// foreign key cascades), and a reading the wipe already deleted answers
// not_found here.
//
// The read (reading-lite-kl7y.7) is one READ ONLY snapshot of the desk and
// the groups the desk page lists around it.

import { fromSql, lockKey } from "../../../control-plane/db";
import type { TenantContext } from "../../../control-plane/ids";
import { DESK_CAP, DESK_GROUP_LIMITS, ListIndexItemSchema, type GetDeskResponse } from "../../../schemas/api";
import type { ManifestStatus } from "../../../schemas/manifest";
import type { Sql, SqlQuery, SqlRow } from "../../db/sql";
import { applyStaleness } from "../../staleness";
import { LIST_COLUMNS, pgTenantId, present } from "./reading-store";

type DeskGroup = "needs_you" | "processing" | "ready_since";

// Each row's status after src/modules/staleness.ts, in its order, and whether
// its last attempt is then a failed reprocess. A batch-owned pending row is
// never stale. A running attempt started before the cutoff ($2) has failed:
// it fails a pending or failed row, and leaves a ready one ready with that
// attempt as its last. Otherwise a pending row last written before the cutoff
// has failed. A failed reprocess under a live attempt is being retried, so it
// no longer needs the reader.
//
// last_finished_at is when that effective attempt finished. An expired running
// attempt finishes at the request clock ($7), so the age predicate cannot
// treat it as the previous attempt.
export const NEEDS_YOU_REPROCESS_AGE_OUT_MS = 7 * 86_400_000;

const EFFECTIVE_ROWS = `base AS (
  SELECT id, created_at, updated_at, status, active_attempt, last_attempt,
         coalesce(status = 'pending' AND active_attempt->>'id' LIKE 'batch\\_%'
           AND active_attempt->>'trigger' IN ('import', 'reprocess')
           AND active_attempt->>'status' = 'running' AND active_attempt->>'stage' = 'summarize', false) AS batch_owned,
         coalesce(active_attempt->>'status' = 'running'
           AND (active_attempt->>'started_at')::timestamptz < $2::timestamptz, false) AS expired
  FROM readings WHERE tenant_id = $1
), effective AS (
  SELECT id, created_at,
         CASE WHEN batch_owned THEN 'pending'
              WHEN expired THEN CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END
              WHEN status = 'pending' AND coalesce(updated_at, created_at) < $2::timestamptz THEN 'failed'
              ELSE status::text END AS status,
         CASE WHEN expired THEN active_attempt->>'trigger' = 'reprocess'
              ELSE coalesce(active_attempt->>'status' IS DISTINCT FROM 'running'
                AND last_attempt->>'trigger' = 'reprocess' AND last_attempt->>'status' = 'failed', false)
         END AS reprocess_failed,
         CASE WHEN expired THEN $7::timestamptz
              ELSE (last_attempt->>'finished_at')::timestamptz
         END AS last_finished_at
  FROM base
)`;

export function pgDeskStoreFor(sql: Sql, tenant: TenantContext, clock: { now: () => string }): PgDeskStore {
  return new PgDeskStore(sql, pgTenantId(tenant), clock);
}

export type DeskAddResult =
  | { kind: "desk"; desk: string[] }
  | { kind: "not_found" }
  | { kind: "not_ready" }
  | { kind: "desk_full" };

export type DeskRemoveResult = { kind: "desk"; desk: string[] } | { kind: "not_found" };

export class PgDeskStore {
  constructor(
    private readonly sql: Sql,
    private readonly tenantId: string,
    private readonly clock: { now: () => string },
  ) {}

  /** Appends a ready reading. One already on the desk, whatever its status, is left where it is. */
  async add(id: string): Promise<DeskAddResult> {
    return this.sql.transaction(async (tx) => {
      await this.lockDesk(tx);
      const status = await this.lockReading(tx, id);
      if (status === null) return { kind: "not_found" } as const;
      const desk = await this.renumber(tx);
      if (desk.includes(id)) return { kind: "desk", desk } as const;
      if (status !== "ready") return { kind: "not_ready" } as const;
      if (desk.length >= DESK_CAP) return { kind: "desk_full" } as const;
      await tx.query(
        "INSERT INTO reading_desk (tenant_id, reading_id, position, added_at) VALUES ($1, $2, $3, $4)",
        [this.tenantId, id, desk.length + 1, this.clock.now()],
      );
      return { kind: "desk", desk: [...desk, id] } as const;
    });
  }

  /** Takes the reading off the desk; one not on it is a no-op. */
  async remove(id: string): Promise<DeskRemoveResult> {
    return this.sql.transaction(async (tx) => {
      await this.lockDesk(tx);
      if ((await this.lockReading(tx, id)) === null) return { kind: "not_found" } as const;
      await tx.execute("DELETE FROM reading_desk WHERE tenant_id = $1 AND reading_id = $2", [this.tenantId, id]);
      return { kind: "desk", desk: await this.renumber(tx) } as const;
    });
  }

  /**
   * GET /api/desk: the desk and the three groups around it, one snapshot.
   * Rows are grouped by their status after read-time staleness, which
   * EFFECTIVE_ROWS mirrors in SQL so the bounds and totals are counted in the
   * database; the returned rows then take applyStaleness itself. A ready
   * reading whose reprocess failed is in ready_since, and in needs_you until
   * that failure's finished_at is more than seven days before the request.
   */
  async read(opts: { since?: string; ttlSeconds: number }): Promise<GetDeskResponse> {
    const now = this.clock.now();
    const cutoff = new Date(Date.parse(now) - opts.ttlSeconds * 1000).toISOString();
    const needsYouCutoff = new Date(Date.parse(now) - NEEDS_YOU_REPROCESS_AGE_OUT_MS).toISOString();
    const { onDesk, grouped } = await this.sql.transaction(
      async (tx) => ({
        onDesk: await tx.query(
          `SELECT ${LIST_COLUMNS} FROM readings
           JOIN reading_desk k ON (k.tenant_id, k.reading_id) = (readings.tenant_id, readings.id)
           WHERE readings.tenant_id = $1 ORDER BY k.position`,
          [this.tenantId],
        ),
        grouped: await tx.query<SqlRow & { desk_group: DeskGroup; group_total: number }>(
          `WITH ${EFFECTIVE_ROWS}, grouped AS (
             SELECT id, created_at, 'needs_you' AS desk_group FROM effective
             WHERE status = 'failed'
                OR (status = 'ready' AND reprocess_failed
                    AND NOT coalesce(last_finished_at < $8::timestamptz, false))
             UNION ALL
             SELECT id, created_at, 'processing' FROM effective WHERE status = 'pending'
             UNION ALL
             SELECT id, created_at, 'ready_since' FROM effective
             WHERE status = 'ready' AND $3::timestamptz IS NOT NULL AND created_at > $3::timestamptz
               AND NOT EXISTS (SELECT 1 FROM reading_desk k WHERE k.tenant_id = $1 AND k.reading_id = effective.id)
           ), ranked AS (
             SELECT id AS ranked_id, desk_group,
                    row_number() OVER (PARTITION BY desk_group ORDER BY created_at DESC, id DESC) AS rank,
                    count(*) OVER (PARTITION BY desk_group)::int AS group_total
             FROM grouped
           )
           SELECT ${LIST_COLUMNS}, ranked.desk_group, ranked.group_total
           FROM readings JOIN ranked ON ranked.ranked_id = readings.id
           WHERE readings.tenant_id = $1
             AND ranked.rank <= CASE ranked.desk_group WHEN 'needs_you' THEN $4::int
                                  WHEN 'processing' THEN $5::int ELSE $6::int END
           ORDER BY readings.created_at DESC, readings.id DESC`,
          [
            this.tenantId,
            cutoff,
            opts.since ?? null,
            DESK_GROUP_LIMITS.needs_you,
            DESK_GROUP_LIMITS.processing,
            DESK_GROUP_LIMITS.ready_since,
            now,
            needsYouCutoff,
          ],
        ),
      }),
      { readOnly: true, repeatableRead: true },
    );
    const item = (row: SqlRow) => applyStaleness(ListIndexItemSchema.parse(present(row)), opts.ttlSeconds, now);
    const group = (name: DeskGroup) => {
      const rows = grouped.filter((row) => row.desk_group === name);
      return {
        rows: rows.map(({ desk_group: _group, group_total: _total, ...row }) => item(row)),
        total: rows[0]?.group_total ?? 0,
      };
    };
    const needsYou = group("needs_you");
    const processing = group("processing");
    const readySince = group("ready_since");
    return {
      on_desk: onDesk.map(item),
      needs_you: needsYou.rows,
      needs_you_total: needsYou.total,
      processing: processing.rows,
      processing_total: processing.total,
      ready_since: readySince.rows,
      ready_since_total: readySince.total,
    };
  }

  async clear(): Promise<string[]> {
    return this.sql.transaction(async (tx) => {
      await this.lockDesk(tx);
      await tx.execute("DELETE FROM reading_desk WHERE tenant_id = $1", [this.tenantId]);
      return [];
    });
  }

  private async lockDesk(tx: SqlQuery): Promise<void> {
    await lockKey(fromSql(tx), `desk:${this.tenantId}`);
  }

  private async lockReading(tx: SqlQuery, id: string): Promise<ManifestStatus | null> {
    const [row] = await tx.query<{ status: ManifestStatus }>(
      "SELECT status FROM readings WHERE tenant_id = $1 AND id = $2 FOR SHARE",
      [this.tenantId, id],
    );
    return row?.status ?? null;
  }

  // Positions 1..n in their current order; only rows whose position moves are
  // written. Returns the desk's reading ids in that order.
  private async renumber(tx: SqlQuery): Promise<string[]> {
    const rows = await tx.query<{ reading_id: string; position: number }>(
      `WITH ordered AS (
         SELECT reading_id, row_number() OVER (ORDER BY position, reading_id)::int AS position
         FROM reading_desk WHERE tenant_id = $1
       ), moved AS (
         UPDATE reading_desk d SET position = o.position
         FROM ordered o
         WHERE d.tenant_id = $1 AND d.reading_id = o.reading_id AND d.position <> o.position
       )
       SELECT reading_id, position FROM ordered ORDER BY position`,
      [this.tenantId],
    );
    return rows.map((row) => row.reading_id);
  }
}
