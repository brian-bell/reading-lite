// Spend enforcement for synchronous paid operator commands (reading-lite-
// gh319.1). Each command wraps its provider fetch here in its --execute branch
// only: plan mode never opens the spend session, so it cannot reach either the
// authority or a provider.
//
// The wrapper is the hosted createPaidFetch unchanged. It sits where the
// provider clients take their `fetch`, which is inside their HTTP retry loops,
// so every retry reserves under a fresh operation identity. Unknown pricing,
// an unsupported payload, a budget denial, and an unreachable authority all
// throw SpendAdmissionError before the provider request is made.

import { OPERATOR_DATABASES, type OperatorDatabaseTarget } from "../pg-lib/operator-db";
import type { OperatorTenant } from "../corpus-lib/tenant";
import { parseTenantId } from "../../src/control-plane/ids";
import { createPaidFetch, type SpendRpc } from "../../src/control-plane/paid-dispatch";
import type { OpenOperatorSpend } from "../system-lib/spend";
import type { PolicyEnvironment } from "../system-lib/policy";
import { UsageError } from "./contract";

export const BILLING_TENANT_FLAG_HELP =
  "--billing-tenant <usr_…>  Tenant whose daily spend cap (with the global cap) admits the paid requests.";

/**
 * Who pays. There is no global-only accounting mode: the authority admits
 * spend against a real tenant's limits plus the global cap, so `--tenant
 * global` and tenantless commands must name a billing tenant to execute.
 * A malformed id is refused in either mode; a missing one only blocks
 * --execute, since a plan spends nothing.
 */
export function resolveBillingTenant(
  raw: string | undefined,
  opts: { tenant?: OperatorTenant; execute: boolean },
): string | undefined {
  if (raw !== undefined) {
    const parsed = parseTenantId(raw);
    if (!parsed) {
      throw new UsageError(`malformed --billing-tenant: ${JSON.stringify(raw)} (expected usr_…)`);
    }
    return String(parsed);
  }
  if (opts.tenant?.kind === "tenant") return opts.tenant.tenantId;
  if (opts.execute) {
    throw new UsageError(
      "--execute requires --billing-tenant <usr_…>: paid requests are admitted against a tenant's spend cap",
    );
  }
  return undefined;
}

/**
 * The payer for a provider batch (reading-lite-gh319.2). A batch in flight
 * settles against the tenant it was admitted under, so a resume takes the
 * payer from its sidecar and refuses a different one; nothing new is
 * admitted on a resume, so it needs no --billing-tenant of its own.
 */
export function resolveBatchBillingTenant(
  raw: string | undefined,
  opts: { tenant: OperatorTenant; execute: boolean; sidecar: { spend?: { tenantId: string } } | null },
): string | undefined {
  const pinned = opts.sidecar?.spend?.tenantId;
  const named = resolveBillingTenant(raw, {
    tenant: opts.tenant,
    execute: opts.execute && pinned === undefined,
  });
  if (pinned === undefined) return named;
  if (raw !== undefined && named !== pinned) {
    throw new UsageError(
      `the in-flight batch was admitted against billing tenant '${pinned}', not '${named}'; ` +
        "resume it without --billing-tenant or with that tenant",
    );
  }
  return pinned;
}

/** The spend authority that goes with a data bucket; no guess for an unknown one. */
export function spendEnvironmentForBucket(bucket: string): PolicyEnvironment {
  const target: OperatorDatabaseTarget | undefined = OPERATOR_DATABASES[bucket];
  if (target === undefined) {
    throw new UsageError(
      `no spend authority is mapped to bucket '${bucket}'. Known buckets: ` +
        `${Object.keys(OPERATOR_DATABASES).join(", ")}`,
    );
  }
  return target.env;
}

/**
 * The default transport of a provider client built without the spend wrapper.
 * A plan never calls it; an execute that somehow does must not reach a
 * provider unadmitted.
 */
export const refuseUnguardedFetch: typeof fetch = async () => {
  throw new Error("internal error: paid provider request without spend admission");
};

export interface OperatorPaidFetchDeps {
  openSpend: OpenOperatorSpend;
  /** The unguarded provider transport; only ever called through the wrapper. */
  fetch: typeof fetch;
  now: () => number;
}

export async function withOperatorPaidFetch<T>(
  deps: OperatorPaidFetchDeps,
  opts: { env: PolicyEnvironment; billingTenant: string | undefined; command: string },
  // `spend` is the raw admission route, for callers that account for work the
  // paid fetch cannot quote (provider batches).
  run: (paidFetch: typeof fetch, spend: { tenantId: string; rpc: SpendRpc }) => Promise<T>,
): Promise<T> {
  // resolveBillingTenant already refuses this for --execute; without a payer
  // there is nothing to admit against, so no session and no transport.
  const billingTenant = opts.billingTenant;
  if (billingTenant === undefined) throw new UsageError("paid requests require --billing-tenant <usr_…>");
  const session = await deps.openSpend(opts.env);
  try {
    return await run(createPaidFetch({
      tenantId: billingTenant,
      attemptId: `operator:${opts.command}`,
      stage: "operator",
      fetch: deps.fetch,
      rpc: session.rpc,
      now: deps.now,
    }), { tenantId: billingTenant, rpc: session.rpc });
  } finally {
    await session.dispose();
  }
}
