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

import { fromSql, lockKey } from "../../../control-plane/db";
import type { TenantContext } from "../../../control-plane/ids";
import { DESK_CAP } from "../../../schemas/api";
import type { ManifestStatus } from "../../../schemas/manifest";
import type { Sql, SqlQuery } from "../../db/sql";
import { pgTenantId } from "./reading-store";

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
    );    return row?.status ?? null;
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
