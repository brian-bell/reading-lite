import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import type { SpendStatus } from "../../../src/control-plane/spend-status";
import { PAID_PRICE_CATALOG_VERSION } from "../../../src/modules/paid-pricing";
import {
  policyDb,
  policyEnvironment,
  readPolicy,
  type PolicyEnvironment,
  type PolicySession,
} from "../../system-lib/policy";
import { remoteSpendStatus } from "../../system-lib/status";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
export interface StatusDeps extends BaseDeps {
  connect(env: PolicyEnvironment): PolicySession;
  accounting(env: PolicyEnvironment, tenant?: string, details?: boolean): Promise<SpendStatus>;
}
export const systemStatusCommand: CommandDefinition<StatusDeps> = {
  group: "system",
  name: "status",
  safety: "read-only",
  summary: "Inspect policy and authoritative current UTC-day spend",
  helpText: `Usage: npm run ops -- system status --env staging|production [--tenant <usr_…>] [--details]
Requires an explicit environment and Cloudflare operator credentials.
Reports charged against budget (including holds and uncertain maxima), not invoices.
Accounting unavailable is an error, never a zero. Policy and accounting are separate
observations, not an atomic snapshot. Tokens and secrets are never printed.
  --details  Inspect bounded retained spend operations, leases, and tenant quota headroom.
             Read-only; incomplete scans return exit 1. Requires updated Worker.
  --help  Show help.`,
  defaultDeps: (io) => ({
    io,
    connect: policyDb,
    accounting: remoteSpendStatus,
  }),
  async run(argv, deps) {
    let v;
    try {
      ({ values: v } = parseArgs({
        args: argv,
        options: { env: { type: "string" }, tenant: { type: "string" }, details: { type: "boolean" } },
      }));
    } catch {
      throw new UsageError("Invalid status arguments");
    }
    const env = policyEnvironment(v.env);
    const tenant = v.tenant === undefined ? undefined : parseTenantId(v.tenant);
    if (tenant === null) throw new UsageError("--tenant must be a usr_… id");
    let session: PolicySession;
    try {
      session = deps.connect(env);
    } catch {
      throw new Error("Policy connection failed");
    }
    let global, tenantPolicy;
    try {
      global = await readPolicy(session.db);
      tenantPolicy = tenant ? await readPolicy(session.db, tenant) : undefined;
    } finally {
      // The accounting call below goes over HTTP, not this connection.
      await session.close();
    }
    deps.io.stdout(
      JSON.stringify(
        {
          env,
          global,
          ...(tenant ? { tenant, tenantPolicy } : {}),
          checkoutCatalogVersion: PAID_PRICE_CATALOG_VERSION,
        },
        null,
        2,
      ),
    );
    try {
      const accounting = await (v.details ? deps.accounting(env, tenant, true) : deps.accounting(env, tenant));
      deps.io.stdout(
        JSON.stringify(
          {
            accounting: "available",
            meaning:
              "charged against budget, including holds and uncertain maxima",
            ...accounting,
          },
          null,
          2,
        ),
      );
      if (v.details && (!accounting.details || !accounting.details.spend.complete || !accounting.details.leases.complete || (tenant && (!accounting.tenantDetails || !accounting.tenantDetails.leases.complete || !accounting.tenantDetails.reservations.complete)))) {
        deps.io.stderr("Inspection incomplete or unavailable; do not infer readiness from partial records.");
        return 1;
      }
      return 0;
    } catch {
      deps.io.stderr(
        "Accounting unavailable: verify Cloudflare credentials and deployment of OperatorStatus. No spend total reported.",
      );
      return 1;
    }
  },
};
