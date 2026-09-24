// One-row policy edits: the acknowledged row version is the SQL compare-and-set
// fence. Global and tenant edits never share an invocation or transaction.
import { z } from "zod";
import type { ControlPlaneDb } from "../../src/control-plane/db";
import { fromSql } from "../../src/control-plane/db";
import type { Sql } from "../../src/modules/db/sql";
import {
  bucketForDeployEnv,
  openOperatorSql,
  resolveOperatorDatabaseUrl,
  type OpenOperatorSql,
} from "../pg-lib/operator-db";
import { UsageError } from "../ops-lib/contract";
export type PolicyEnvironment = "staging" | "production";
export function policyEnvironment(
  value: string | undefined,
): PolicyEnvironment {
  if (value !== "staging" && value !== "production")
    throw new UsageError("--env must be staging or production");
  return value;
}

export interface PolicySession {
  db: ControlPlaneDb;
  /** Closes the connection. Safe to call more than once. */
  close: () => Promise<void>;
}

export interface PolicyDbOptions {
  databaseUrlEnv?: string;
  open?: OpenOperatorSql;
  env?: Record<string, string | undefined>;
}

/**
 * The control plane for a policy read or edit, over a direct PostgreSQL
 * connection (ADR 0005) rather than wrangler D1 — the D1 database no Worker
 * binding reads any more, where a cap the operator believed was set never
 * applied. The caller owns the session and must `close` it; `withPolicyDb` is
 * the safe form.
 */
export function policyDb(env: PolicyEnvironment, opts: PolicyDbOptions = {}): PolicySession {
  const { db, sql } = policyDbSession(env, opts);
  return { db, close: () => sql.end().catch(() => undefined) };
}

function policyDbSession(
  env: PolicyEnvironment,
  opts: PolicyDbOptions = {},
): { db: ControlPlaneDb; sql: Sql } {
  const { url } = resolveOperatorDatabaseUrl({
    bucket: bucketForDeployEnv(env),
    ...(opts.databaseUrlEnv === undefined ? {} : { databaseUrlEnv: opts.databaseUrlEnv }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const sql = (opts.open ?? openOperatorSql)(url);
  return { db: fromSql(sql), sql };
}

/** Runs `work` against the environment's control plane and closes the session. */
export async function withPolicyDb<T>(
  env: PolicyEnvironment,
  work: (db: ControlPlaneDb) => Promise<T>,
  opts: PolicyDbOptions = {},
): Promise<T> {
  const session = policyDb(env, opts);
  try {
    return await work(session.db);
  } finally {
    await session.close();
  }
}
export function positiveInteger(value: string, flag: string): number {
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  )
    throw new UsageError(`${flag} must be a positive safe integer`);
  return Number(value);
}
const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PolicyRowSchema = z.object({
  policy_version: Positive,
  daily_spend_microdollars: Positive.nullable(),
  // PostgreSQL's system_policy.paid_work_enabled is `boolean` (migration 0003)
  // and pg returns a JS boolean for it. The operator's 0|1 spelling is kept —
  // it is what the CLI prints and what the plan/execute diff compares — so the
  // boolean is normalized here rather than at each reader.
  paid_work_enabled: z
    .union([z.literal(0), z.literal(1), z.boolean()])
    .optional()
    .transform((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)),
  catalog_version: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export type PolicyRow = z.infer<typeof PolicyRowSchema>;
export async function readPolicy(
  db: ControlPlaneDb,
  tenant?: string,
): Promise<PolicyRow> {
  try {
    const row = tenant
      ? await db.first(
          "SELECT policy_version, daily_spend_microdollars FROM tenant_limits WHERE tenant_id = ?",
          tenant,
        )
      : await db.first(
          "SELECT policy_version, daily_spend_microdollars, paid_work_enabled, catalog_version FROM system_policy WHERE id = 1",
        );
    if (!row) throw new Error("missing");
    const parsed = PolicyRowSchema.parse(row);
    if (
      !tenant &&
      (parsed.paid_work_enabled === undefined ||
        parsed.catalog_version === undefined)
    )
      throw new Error("incomplete");
    return parsed;
  } catch {
    // Wrangler errors can contain credentials or upstream bodies. Only emit
    // our fixed diagnostic at this operator boundary.
    throw new Error(
      "Policy read failed: verify the environment, row, credentials, and migrations",
    );
  }
}
