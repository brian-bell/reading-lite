import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import type { SpendStatus } from "../../../src/control-plane/spend-status";
import { PAID_PRICE_CATALOG_VERSION } from "../../../src/modules/paid-pricing";
import {
  policyDb,
  policyEnvironment,
  readPolicy,
  type PolicyEnvironment,
} from "../../system-lib/policy";
import { remoteSpendStatus } from "../../system-lib/status";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
export interface StatusDeps extends BaseDeps {
  connect(env: PolicyEnvironment): ControlPlaneDb;
  accounting(env: PolicyEnvironment, tenant?: string): Promise<SpendStatus>;
}
export const systemStatusCommand: CommandDefinition<StatusDeps> = {
  group: "system",
  name: "status",
  safety: "read-only",
  summary: "Inspect policy and authoritative current UTC-day spend",
  helpText: `Usage: npm run ops -- system status --env staging|production [--tenant <usr_…>]
Requires an explicit environment and Cloudflare operator credentials.
Reports charged against budget (including holds and uncertain maxima), not invoices.
Accounting unavailable is an error, never a zero. Policy and accounting are separate
observations, not an atomic snapshot. Tokens and secrets are never printed.
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
        options: { env: { type: "string" }, tenant: { type: "string" } },
      }));
    } catch {
      throw new UsageError("Invalid status arguments");
    }
    const env = policyEnvironment(v.env);
    const tenant = v.tenant === undefined ? undefined : parseTenantId(v.tenant);
    if (tenant === null) throw new UsageError("--tenant must be a usr_… id");
    let db: ControlPlaneDb;
    try {
      db = deps.connect(env);
    } catch {
      throw new Error("Policy connection failed");
    }
    const global = await readPolicy(db);
    const tenantPolicy = tenant ? await readPolicy(db, tenant) : undefined;
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
      const accounting = await deps.accounting(env, tenant);
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
      return 0;
    } catch {
      deps.io.stderr(
        "Accounting unavailable: verify Cloudflare credentials and deployment of OperatorStatus. No spend total reported.",
      );
      return 1;
    }
  },
};
