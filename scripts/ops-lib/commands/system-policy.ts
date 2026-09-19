import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { PAID_PRICE_CATALOG_VERSION } from "../../../src/modules/paid-pricing";
import {
  policyDb,
  policyEnvironment,
  positiveInteger,
  readPolicy,
  type PolicyEnvironment,
  type PolicyRow,
} from "../../system-lib/policy";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import {
  POLICY_IDEMPOTENCY_PHRASE,
  POLICY_REDACTION_PHRASE,
  type PolicyContractCapable,
} from "../policy-contract";

export interface PolicyDeps extends BaseDeps {
  connect(env: PolicyEnvironment): ControlPlaneDb;
  now(): number;
}
export const systemPolicyCommand: CommandDefinition<PolicyDeps> &
  PolicyContractCapable = {
  group: "system",
  name: "policy",
  safety: "plan-first",
  summary: "Plan or apply a versioned paid-work policy change",
  helpText: `Usage: npm run ops -- system policy --env staging|production [changes]
  --paid-work enabled|disabled         Set hosted paid-work permission (never toggle).
  --daily-spend-microdollars <integer>  Set a positive daily budget (1000000 = $1).
  --catalog-version <integer>          Set this checkout's supported pricing catalog.
  --tenant <usr_…>                     Edit only this tenant's daily budget.
  --execute                           Apply; otherwise print a read-only plan.
  --acknowledge-guard-version <n>       Required on execute: selected row's policy_version.
  --confirm-production                Also required for production writes.
  --help                              Show help.
Global and tenant edits use separate invocations. Unchanged values keep their version.
Stale acknowledgements refuse, including replay after a successful version increment;
inspect again before executing. Disabling never refunds charges or cancels in-flight work.
${POLICY_IDEMPOTENCY_PHRASE}
This is a state guarantee, not a promise of success for stale-version retries.
${POLICY_REDACTION_PHRASE}`,
  defaultDeps: (io) => ({ io, connect: policyDb, now: Date.now }),
  makeContractDeps() {
    const make = (writes: boolean): PolicyDeps => {
      const rows = new Map<string, PolicyRow>();
      return {
        io: { stdout() {}, stderr() {} },
        now: () => 123,
        connect(env) {
          if (!rows.has(env))
            rows.set(env, {
              policy_version: 3,
              daily_spend_microdollars: 1000000,
              paid_work_enabled: 1,
              catalog_version: 1,
            });
          return {
            first: async <T>() => ({ ...rows.get(env)! }) as T,
            all: async () => [],
            batch: async () => {
              throw new Error("unexpected batch");
            },
            run: async () => {
              if (!writes) throw new Error("write in contract probe");
              rows.set(env, {
                ...rows.get(env)!,
                policy_version: 4,
                paid_work_enabled: 0,
              });
              return { changes: 1 };
            },
            transaction: () => {
              throw new Error("unexpected transaction");
            },
          };
        },
      };
    };
    return {
      deps: make(false),
      executeControlDeps: make(true),
      options: {
        currentGuardVersion: 3,
        baselineArgv: ["--paid-work", "disabled"],
      },
    };
  },
  async run(argv, deps) {
    let v;
    try {
      ({ values: v } = parseArgs({
        args: argv,
        options: {
          env: { type: "string" },
          tenant: { type: "string" },
          "paid-work": { type: "string" },
          "daily-spend-microdollars": { type: "string" },
          "catalog-version": { type: "string" },
          execute: { type: "boolean" },
          "confirm-production": { type: "boolean" },
          "acknowledge-guard-version": { type: "string" },
        },
      }));
    } catch {
      throw new UsageError("Invalid policy arguments");
    }
    const env = policyEnvironment(v.env);
    const tenant = v.tenant === undefined ? undefined : parseTenantId(v.tenant);
    if (tenant === null) throw new UsageError("--tenant must be a usr_… id");
    const patch: Partial<PolicyRow> = {};
    if (v["paid-work"] !== undefined) {
      if (!["enabled", "disabled"].includes(v["paid-work"]))
        throw new UsageError("--paid-work must be enabled or disabled");
      patch.paid_work_enabled = v["paid-work"] === "enabled" ? 1 : 0;
    }
    if (v["daily-spend-microdollars"] !== undefined)
      patch.daily_spend_microdollars = positiveInteger(
        v["daily-spend-microdollars"],
        "--daily-spend-microdollars",
      );
    if (v["catalog-version"] !== undefined) {
      patch.catalog_version = positiveInteger(
        v["catalog-version"],
        "--catalog-version",
      );
      if (patch.catalog_version !== PAID_PRICE_CATALOG_VERSION)
        throw new UsageError(
          `This checkout supports catalog ${PAID_PRICE_CATALOG_VERSION}`,
        );
    }
    if (!Object.keys(patch).length)
      throw new UsageError("Specify at least one policy change");
    if (
      tenant &&
      (patch.paid_work_enabled !== undefined ||
        patch.catalog_version !== undefined)
    )
      throw new UsageError(
        "Tenant changes support only --daily-spend-microdollars",
      );
    const ack =
      v["acknowledge-guard-version"] === undefined
        ? undefined
        : positiveInteger(
            v["acknowledge-guard-version"],
            "--acknowledge-guard-version",
          );
    if (v.execute && ack === undefined)
      throw new UsageError("--execute requires --acknowledge-guard-version");
    if (v.execute && env === "production" && !v["confirm-production"])
      throw new UsageError("Production execute requires --confirm-production");
    let db: ControlPlaneDb;
    try {
      db = deps.connect(env);
    } catch {
      throw new Error("Policy connection failed");
    }
    const before = await readPolicy(db, tenant);
    // Convergence is about stored state. A repeated old command leaves its
    // result intact but must still refuse: allowing a stale acknowledgement
    // through would weaken the operator contract. No request ledger is needed.
    if (ack !== undefined && ack !== before.policy_version)
      throw new UsageError(
        `Policy version changed: acknowledged ${ack}, current ${before.policy_version}; inspect again`,
      );
    const after = { ...before, ...patch };
    if (
      patch.paid_work_enabled === 1 &&
      (after.daily_spend_microdollars === null ||
        after.catalog_version !== PAID_PRICE_CATALOG_VERSION)
    )
      throw new UsageError(
        "Enabling paid work requires an explicit global budget and the supported catalog version",
      );
    const changes = Object.entries(patch).filter(
      ([key, value]) => before[key as keyof PolicyRow] !== value,
    );
    if (changes.length && before.policy_version === Number.MAX_SAFE_INTEGER)
      throw new Error("Policy version exhausted");
    after.policy_version += changes.length ? 1 : 0;
    deps.io.stdout(
      JSON.stringify(
        {
          mode: v.execute ? "EXECUTE" : "PLAN",
          env,
          target: tenant ?? "global",
          before,
          after,
          daily_budget_usd:
            after.daily_spend_microdollars === null
              ? null
              : (after.daily_spend_microdollars / 1000000).toFixed(6),
        },
        null,
        2,
      ),
    );
    if (!v.execute || !changes.length) return 0;
    const table = tenant ? "tenant_limits" : "system_policy";
    let changed: number;
    try {
      ({ changes: changed } = await db.run(
        `UPDATE ${table} SET ${changes.map(([key]) => `${key} = ?`).join(", ")}, policy_version = policy_version + 1, updated_at_ms = ? WHERE ${tenant ? "tenant_id = ?" : "id = 1"} AND policy_version = ?`,
        ...changes.map(([, value]) => value),
        deps.now(),
        ...(tenant ? [tenant] : []),
        before.policy_version,
      ));
    } catch {
      throw new Error(
        "Policy write outcome unavailable; inspect current policy before retrying",
      );
    }
    if (changed !== 1)
      throw new Error(
        "Policy changed during execute; inspect again before retrying",
      );
    deps.io.stdout(
      `Applied policy version ${after.policy_version}. Spend charges are unchanged.`,
    );
    return 0;
  },
};
