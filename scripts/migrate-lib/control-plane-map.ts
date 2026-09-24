// D1 control-plane rows to PostgreSQL rows (reading-lite-gh348), column by
// column, as ADR 0005's "D1 to PostgreSQL column mapping" table states it.
//
// The mapping is declarative on purpose: one spec per table drives the D1
// SELECT, the conversion, the INSERT, and the read-back comparison, so the
// importer cannot convert a column one way and verify it another. Every D1
// column is either mapped or named in `dropped`; a column the spec does not
// know is an error, never a silent discard, which is what catches a D1
// migration landing after this file was written.
//
// Conversions (ADR 0005):
//   ms    epoch-millisecond INTEGER -> timestamptz, millisecond kept
//   flag  0/1 INTEGER               -> boolean
//   json  JSON held as TEXT         -> jsonb
//   iso   ISO-8601 TEXT             -> timestamptz
//   same  unchanged (text, integer, and integer -> bigint)

import { toTimestamp } from "../../src/control-plane/pg-time";
import type { SqlQuery } from "../../src/modules/db/sql";

export type ColumnKind = "same" | "ms" | "flag" | "json" | "iso";

export interface ColumnSpec {
  d1: string;
  pg: string;
  kind: ColumnKind;
}

export interface TableSpec {
  table: string;
  // D1 ORDER BY: the primary key, so pages are stable and the snapshot is
  // deterministic. auth_challenges orders by rowid, which it also exports.
  orderBy: string;
  // Extra D1 select expressions ahead of `*`.
  selectExtra?: string;
  columns: ColumnSpec[];
  // D1 columns with no PostgreSQL counterpart (ADR 0005: "not imported").
  dropped?: string[];
  // Identity column to restart above max() once rows are in.
  identity?: string;
}

const col = (d1: string, kind: ColumnKind = "same", pg?: string): ColumnSpec => ({
  d1,
  pg: pg ?? (kind === "ms" ? d1.replace(/_ms$/, "") : d1),
  kind,
});

// Insert order follows the foreign keys: users first, api_tokens before
// api_token_scopes; the rest in any order (ADR 0005).
export const CONTROL_PLANE_TABLES: readonly TableSpec[] = [
  {
    table: "users",
    orderBy: "id",
    columns: [
      col("id"), col("email_canonical"), col("email_display"), col("status"),
      col("email_verified_at_ms", "ms"), col("created_at_ms", "ms"), col("updated_at_ms", "ms"),
      col("suspended_at_ms", "ms"), col("deleting_at_ms", "ms"),
    ],
  },
  {
    table: "user_settings",
    orderBy: "user_id",
    columns: [
      col("user_id"), col("schema_version"), col("notify_immediate", "flag"), col("digest_cadence"),
      col("time_zone"), col("digest_hour_local"), col("digest_weekday"),
      col("created_at_ms", "ms"), col("updated_at_ms", "ms"),
    ],
  },
  {
    table: "tenant_limits",
    orderBy: "tenant_id",
    columns: [
      col("tenant_id"), col("policy_version"), col("submissions_per_hour"), col("monthly_readings"),
      col("max_concurrent_work"), col("daily_spend_microdollars"),
      col("created_at_ms", "ms"), col("updated_at_ms", "ms"),
    ],
  },
  {
    table: "api_tokens",
    orderBy: "id",
    columns: [
      col("id"), col("user_id"), col("name"), col("format"), col("secret_hmac"), col("hash_key_version"),
      col("created_at_ms", "ms"), col("expires_at_ms", "ms"), col("revoked_at_ms", "ms"),
      col("last_used_at_ms", "ms"), col("user_agent_label"),
    ],
  },
  {
    table: "api_token_scopes",
    orderBy: "token_id, scope",
    columns: [col("token_id"), col("scope")],
  },
  {
    table: "system_policy",
    orderBy: "id",
    columns: [
      col("id"), col("signup_mode"), col("paid_work_enabled", "flag"), col("policy_version"),
      col("catalog_version"), col("updated_at_ms", "ms"), col("max_concurrent_work"),
      // NULL stays NULL: a missing global ceiling is fail-closed.
      col("daily_spend_microdollars"),
    ],
  },
  {
    table: "sessions",
    orderBy: "id",
    columns: [
      col("id"), col("user_id"), col("secret_hmac"), col("hash_key_version"),
      col("created_at_ms", "ms"), col("authenticated_at_ms", "ms"), col("last_seen_at_ms", "ms"),
      col("idle_expires_at_ms", "ms"), col("absolute_expires_at_ms", "ms"), col("revoked_at_ms", "ms"),
      col("revocation_reason"), col("user_agent_label"), col("created_from_claim_id"),
    ],
  },
  {
    table: "auth_challenges",
    // SQLite rowid is insert order, which issue_seq preserves (0004).
    orderBy: "rowid",
    selectExtra: "rowid AS issue_seq",
    identity: "issue_seq",
    columns: [
      col("issue_seq"), col("id"), col("purpose"), col("email_canonical"), col("email_display"), col("user_id"),
      col("secret_hmac"), col("hash_key_version"), col("issued_at_ms", "ms"), col("expires_at_ms", "ms"),
      col("state"), col("claim_id"), col("claimed_at_ms", "ms"), col("consumed_at_ms", "ms"),
      col("completed_user_id"), col("completed_session_id"), col("mail_sent_at_ms", "ms"), col("bound_session_id"),
    ],
  },
  {
    table: "signup_invites",
    orderBy: "email_canonical",
    columns: [
      col("email_canonical"), col("email_display"), col("created_at_ms", "ms"),
      col("expires_at_ms", "ms"), col("consumed_at_ms", "ms"),
    ],
  },
  {
    table: "dev_mail_outbox",
    orderBy: "id",
    identity: "id",
    columns: [col("id"), col("to_email"), col("subject"), col("verify_url"), col("sent_at_ms", "ms")],
  },
  {
    table: "digest_deliveries",
    orderBy: "user_id, cadence, period_key",
    columns: [
      col("user_id"), col("cadence"), col("period_key"), col("status"), col("skip_reason"),
      col("created_at_ms", "ms"), col("updated_at_ms", "ms"), col("resend_id"),
    ],
  },
  {
    table: "relationship_refresh_jobs",
    orderBy: "tenant_id, reading_id",
    columns: [
      col("tenant_id"), col("reading_id"), col("run_at", "iso"), col("owner"), col("source_etag"),
      col("result_json", "json"), col("retry_at_ms", "ms"),
    ],
  },
  {
    table: "wipe_progress",
    orderBy: "tenant_id",
    columns: [
      col("tenant_id"),
      // Always 'done': only completed wipes import (checkWipes refuses the rest).
      col("phase"),
      col("lease_seq"), col("updated_at_ms", "ms"), col("r2_cursor"), col("force", "flag"),
      col("objects_deleted"), col("continuations"), col("completed_at_ms", "ms"), col("residue", "flag"),
      col("first_completed_at_ms", "ms"), col("first_residue", "flag"),
    ],
    dropped: [
      "vector_cursor", "mutation_ids", "index_count_sampled", "index_count_start", "probe_attempts",
      "probe_saw_residue", "seed_cursor", "seed_completed_at_ms",
    ],
  },
  {
    table: "account_deletions",
    orderBy: "tenant_id",
    columns: [
      col("tenant_id"), col("deleting_at_ms", "ms"), col("completed_at_ms", "ms"), col("residue", "flag"),
      col("first_completed_at_ms", "ms"), col("first_residue", "flag"), col("torn_down_at_ms", "ms"),
    ],
  },
];

// Read for reconciliation only: embeddings are rows now, so the ledger has no
// PostgreSQL counterpart (ADR 0005), but it is D1's record of which vectors
// should exist.
export const VECTOR_LEDGER_TABLE = { table: "vector_ledger", orderBy: "tenant_id, reading_id" } as const;

export class ControlPlaneRowError extends Error {}

function convert(table: string, spec: ColumnSpec, value: unknown): unknown {
  const where = `${table}.${spec.d1}`;
  if (value === null || value === undefined) return null;
  switch (spec.kind) {
    case "same":
      if (typeof value !== "string" && typeof value !== "number") {
        throw new ControlPlaneRowError(`${where}: expected text or integer, got ${JSON.stringify(value)}`);
      }
      return value;
    case "ms":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new ControlPlaneRowError(`${where}: expected epoch milliseconds, got ${JSON.stringify(value)}`);
      }
      return toTimestamp(value);
    case "flag":
      if (value !== 0 && value !== 1) throw new ControlPlaneRowError(`${where}: expected 0 or 1, got ${JSON.stringify(value)}`);
      return value === 1;
    case "json":
      if (typeof value !== "string") throw new ControlPlaneRowError(`${where}: expected JSON text, got ${JSON.stringify(value)}`);
      try {
        JSON.parse(value);
      } catch {
        throw new ControlPlaneRowError(`${where}: not valid JSON`);
      }
      // Passed as text and cast in the INSERT: pg would turn an array into a
      // PostgreSQL array rather than JSON.
      return value;
    case "iso": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new ControlPlaneRowError(`${where}: expected an ISO-8601 timestamp, got ${JSON.stringify(value)}`);
      }
      return new Date(value);
    }
  }
}

/** One D1 row as the PostgreSQL parameters its INSERT takes, in column order. */
export function toPgRow(spec: TableSpec, row: Record<string, unknown>): unknown[] {
  const known = new Set([...spec.columns.map((c) => c.d1), ...(spec.dropped ?? [])]);
  const unknown = Object.keys(row).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ControlPlaneRowError(
      `${spec.table}: D1 column(s) ${unknown.join(", ")} have no mapping; refusing to drop them silently`,
    );
  }
  return spec.columns.map((c) => {
    if (spec.table === "wipe_progress" && c.d1 === "phase") return "done";
    return convert(spec.table, c, row[c.d1]);
  });
}

/**
 * A row reduced to values both sides can be compared on: timestamps as epoch
 * milliseconds, flags as booleans, JSON as a parsed value. `side` says whether
 * the row is a D1 row (by d1 column name) or a PostgreSQL row (by pg name).
 */
export function comparableRow(spec: TableSpec, row: Record<string, unknown>, side: "d1" | "pg"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of spec.columns) {
    const raw = row[side === "d1" ? c.d1 : c.pg];
    let value: unknown = raw ?? null;
    if (value !== null) {
      if (c.kind === "ms" || c.kind === "iso") {
        value = side === "d1" && c.kind === "ms" ? value : Date.parse(String(value));
      } else if (c.kind === "flag") {
        value = side === "d1" ? value === 1 : value;
      } else if (c.kind === "json") {
        value = side === "d1" ? JSON.parse(String(value)) : value;
      }
    }
    if (side === "d1" && spec.table === "wipe_progress" && c.d1 === "phase") value = "done";
    out[c.pg] = value;
  }
  return out;
}

export async function insertControlPlaneRows(
  tx: SqlQuery,
  spec: TableSpec,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const names = spec.columns.map((c) => c.pg).join(", ");
  const placeholders = spec.columns.map((c, i) => `$${i + 1}${c.kind === "json" ? "::jsonb" : ""}`).join(", ");
  const text = `INSERT INTO ${spec.table} (${names}) VALUES (${placeholders})`;
  for (const row of rows) await tx.query(text, toPgRow(spec, row));
  if (spec.identity && rows.length > 0) {
    // BY DEFAULT identities accept the imported values, but the sequence
    // behind them still starts at 1; restart it above the largest one.
    await tx.query(
      `SELECT setval(pg_get_serial_sequence('${spec.table}', '${spec.identity}'), (SELECT max(${spec.identity}) FROM ${spec.table}))`,
    );
  }
}

export async function readControlPlaneTable(tx: SqlQuery, spec: TableSpec): Promise<Record<string, unknown>[]> {
  const order = spec.orderBy === "rowid" ? spec.identity! : spec.orderBy;
  return tx.query(`SELECT * FROM ${spec.table} ORDER BY ${order}`);
}
