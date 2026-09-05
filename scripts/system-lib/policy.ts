// One-row policy edits: the acknowledged row version is the SQL compare-and-set
// fence. Global and tenant edits never share an invocation or transaction.
import { z } from "zod";
import type { ControlPlaneDb } from "../../src/control-plane/db";
import { controlPlaneDbForBucket } from "../account-lib/control-plane";
import { UsageError } from "../ops-lib/contract";
export type PolicyEnvironment = "staging" | "production";
export function policyEnvironment(
  value: string | undefined,
): PolicyEnvironment {
  if (value !== "staging" && value !== "production")
    throw new UsageError("--env must be staging or production");
  return value;
}
export function policyDb(env: PolicyEnvironment): ControlPlaneDb {
  return controlPlaneDbForBucket(
    env === "production" ? "reading-lite" : "reading-lite-staging",
  );
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
  paid_work_enabled: z.union([z.literal(0), z.literal(1)]).optional(),
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
