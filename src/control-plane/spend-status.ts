// Diagnostics read the same counters as admission. Charged includes unsettled
// maxima and holds; it is deliberately not described as a provider invoice.
import { OperatorDetailsSchema, TenantInspectionSchema } from "./operator-inspection";
import { z } from "zod";
import { utcSpendDay, utcSpendDayResetAt } from "./spend-ledger";
import { GLOBAL_USAGE_GUARD_NAME } from "./constants";
const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SpendStatusSchema = z.object({
  details: OperatorDetailsSchema.optional(),
  tenantDetails: TenantInspectionSchema.optional(),
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observedAtMs: Amount,
  resetAtMs: Amount,
  globalChargedMicrodollars: Amount,
  tenantId: z.string().optional(),
  tenantChargedMicrodollars: Amount.optional(),
});
export type SpendStatus = z.infer<typeof SpendStatusSchema>;
export async function readSpendStatus(
  storage: Pick<DurableObjectStorage, "get">,
  now: number,
  tenantId?: string,
): Promise<SpendStatus> {
  const dayKey = utcSpendDay(now);
  async function charged(key: string) {
    const counter = await storage.get(key);
    return counter === undefined
      ? 0
      : z.object({ microdollars: Amount }).parse(counter).microdollars;
  }
  return {
    dayKey,
    observedAtMs: now,
    resetAtMs: utcSpendDayResetAt(now),
    globalChargedMicrodollars: await charged(`spend:day:${dayKey}`),
    ...(tenantId
      ? {
          tenantId,
          tenantChargedMicrodollars: await charged(
            `spend:tenant:${tenantId}:day:${dayKey}`,
          ),
        }
      : {}),
  };
}

/** One tenant's counters from the guard; null when it is unbound or cannot answer. */
export async function fetchTenantSpendStatus(
  ns: DurableObjectNamespace | undefined,
  tenantId: string,
): Promise<SpendStatus & { tenantChargedMicrodollars: number } | null> {
  if (!ns) return null;
  try {
    const response = await ns.get(ns.idFromName(GLOBAL_USAGE_GUARD_NAME)).fetch("https://guard/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "spend_status", tenantId }),
    });
    if (!response.ok) return null;
    const status = SpendStatusSchema.parse(await response.json());
    if (status.tenantId !== tenantId || status.tenantChargedMicrodollars === undefined) return null;
    return { ...status, tenantChargedMicrodollars: status.tenantChargedMicrodollars };
  } catch {
    return null;
  }
}
