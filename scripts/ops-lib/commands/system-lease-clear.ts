import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import {
  policyEnvironment,
  type PolicyEnvironment,
} from "../../system-lib/policy";
import {
  observeFromSpendStatus,
  remoteLeaseClear,
  type LeaseClearResponse,
  type LeaseObservation,
} from "../../system-lib/lease-clear";
import { remoteSpendStatus } from "../../system-lib/status";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

// #256: fenced, idempotent operator recovery for a dead attempt's in-flight
// lease rows. Plan-first like every durable op: the plan is the observation
// (tenant row, global row, ages, verdicts); --execute re-observes FRESH and
// compare-and-set clears each side on the expiresAt it just saw. A row that
// renewed in between refuses ("changed") — a live holder can never be stolen
// from. Not-overdue rows refuse outright; paused rows belong to the expiry
// sweep, not to this command.

export interface LeaseClearDeps extends BaseDeps {
  observe(env: PolicyEnvironment, tenant: string, attemptId: string): Promise<LeaseObservation>;
  clear(
    env: PolicyEnvironment,
    tenant: string,
    attemptId: string,
    expected: { tenant: number | null; global: number | null },
  ): Promise<LeaseClearResponse>;
}

type SideVerdict =
  | { action: "absent" }
  | { action: "clear"; expectedExpiresAt: number }
  | { action: "refuse"; reason: "not_in_flight" | "not_overdue" };

function verdict(row: LeaseObservation["tenantRow"], observedAtMs: number): SideVerdict {
  if (row === null) return { action: "absent" };
  if (!row.inFlight) return { action: "refuse", reason: "not_in_flight" };
  if (row.expiresAtMs > observedAtMs) return { action: "refuse", reason: "not_overdue" };
  return { action: "clear", expectedExpiresAt: row.expiresAtMs };
}

function describeRow(row: LeaseObservation["tenantRow"], observedAtMs: number) {
  if (row === null) return "absent";
  return {
    expiresAtMs: row.expiresAtMs,
    inFlight: row.inFlight,
    heartbeatOverdueMs: row.heartbeatOverdueMs,
    expiresInSeconds: Math.round((row.expiresAtMs - observedAtMs) / 1000),
  };
}

function refusalMessage(side: "tenant" | "global", reason: string): string {
  if (reason === "not_overdue") {
    return `${side} lease is not overdue — the holder may still be live; refusing to clear`;
  }
  return `${side} lease is paused, not orphaned — the expiry sweep owns it; refusing to clear`;
}

export const systemLeaseClearCommand: CommandDefinition<LeaseClearDeps> = {
  group: "system",
  name: "lease-clear",
  safety: "plan-first",
  summary: "Recover a dead attempt's orphaned in-flight processing leases",
  helpText: `Usage: npm run ops -- system lease-clear --env staging|production --tenant <usr_…> --attempt <attemptId> [--execute]
Requires an explicit environment and Cloudflare operator credentials.
Observes the tenant and global guard rows for the attempt (read-only; no fences,
credentials, or reading content are ever printed). Plans by default; --execute
re-observes and compare-and-set clears each side on the expiresAt just observed.
Refuses rows that are not overdue (a live holder may own them) or not in flight
(paused rows belong to the expiry sweep). Absent rows are success — re-running
converges. A row that renewed between observation and clear refuses with
"changed"; observe again before retrying. Requires an updated Worker with the
OperatorLeaseClear entrypoint.
  --tenant <usr_…>  The tenant whose guard holds the lease (production: /api/whoami's tenant_id).
  --attempt <id>    The attempt id of the orphaned lease (from system status --details).
  --execute        Clear both sides; otherwise print the observed plan only.
  --help           Show help.`,
  defaultDeps: (io) => ({
    io,
    observe: async (env, tenant, attemptId) =>
      observeFromSpendStatus(await remoteSpendStatus(env, tenant, true), tenant, attemptId),
    clear: remoteLeaseClear,
  }),
  async run(argv, deps) {
    let v;
    try {
      ({ values: v } = parseArgs({
        args: argv,
        options: {
          env: { type: "string" },
          tenant: { type: "string" },
          attempt: { type: "string" },
          execute: { type: "boolean" },
        },
      }));
    } catch {
      throw new UsageError("Invalid lease-clear arguments");
    }
    const env = policyEnvironment(v.env);
    const tenant = v.tenant === undefined ? null : parseTenantId(v.tenant);
    if (tenant === null) throw new UsageError("--tenant must be a usr_… id");
    const attemptId = v.attempt ?? "";
    if (!attemptId) throw new UsageError("--attempt is required");

    let observed: LeaseObservation;
    try {
      observed = await deps.observe(env, tenant, attemptId);
    } catch {
      deps.io.stderr(
        "Lease observation unavailable: verify Cloudflare credentials and deployment of OperatorStatus (--details).",
      );
      return 1;
    }

    const tenantVerdict = verdict(observed.tenantRow, observed.observedAtMs);
    const globalVerdict = verdict(observed.globalRow, observed.observedAtMs);
    deps.io.stdout(
      JSON.stringify(
        {
          mode: v.execute ? "EXECUTE" : "PLAN",
          env,
          tenant,
          attemptId,
          observedAtMs: observed.observedAtMs,
          tenantLease: { row: describeRow(observed.tenantRow, observed.observedAtMs), verdict: tenantVerdict.action },
          globalLease: { row: describeRow(observed.globalRow, observed.observedAtMs), verdict: globalVerdict.action },
        },
        null,
        2,
      ),
    );

    if (tenantVerdict.action === "absent" && globalVerdict.action === "absent") {
      deps.io.stdout("Nothing to clear: no lease rows exist for this attempt.");
      return 0;
    }
    const refusals = [
      ...(tenantVerdict.action === "refuse" ? [["tenant", tenantVerdict.reason] as const] : []),
      ...(globalVerdict.action === "refuse" ? [["global", globalVerdict.reason] as const] : []),
    ];
    if (refusals.length) {
      for (const [side, reason] of refusals) {
        deps.io.stderr(refusalMessage(side, reason));
      }
      // A refused side means the rows may be live; never clear the other side
      // on the strength of this observation.
      return 1;
    }
    if (!v.execute) {
      deps.io.stdout("Plan only. Re-run with --execute to clear both sides.");
      return 0;
    }

    // Execute re-observes: the CAS must ride the snapshot THIS invocation saw,
    // not one printed by an earlier plan that has since gone stale.
    let fresh: LeaseObservation;
    try {
      fresh = await deps.observe(env, tenant, attemptId);
    } catch {
      deps.io.stderr("Lease observation unavailable before execute; nothing was cleared.");
      return 1;
    }
    const freshTenant = verdict(fresh.tenantRow, fresh.observedAtMs);
    const freshGlobal = verdict(fresh.globalRow, fresh.observedAtMs);
    const freshRefusals = [
      ...(freshTenant.action === "refuse" ? [["tenant", freshTenant.reason] as const] : []),
      ...(freshGlobal.action === "refuse" ? [["global", freshGlobal.reason] as const] : []),
    ];
    if (freshRefusals.length) {
      for (const [side, reason] of freshRefusals) {
        deps.io.stderr(refusalMessage(side, reason));
      }
      deps.io.stderr("Nothing was cleared; observe again before retrying.");
      return 1;
    }

    let outcome: LeaseClearResponse;
    try {
      outcome = await deps.clear(
        env,
        tenant,
        attemptId,
        {
          tenant: freshTenant.action === "clear" ? freshTenant.expectedExpiresAt : null,
          global: freshGlobal.action === "clear" ? freshGlobal.expectedExpiresAt : null,
        },
      );
    } catch {
      deps.io.stderr(
        "Lease clear unavailable: verify credentials and Worker deployment. Re-run; an already-cleared side converges.",
      );
      return 1;
    }
    const reportSide = (side: "tenant" | "global", decision: LeaseClearResponse["tenant"]): 0 | 1 => {
      if (decision.ok) {
        deps.io.stdout(`${side}: ${decision.cleared ? "cleared" : "already absent"}`);
        return 0;
      }
      deps.io.stderr(
        `${side} clear refused (${decision.reason}); nothing further was cleared on that side. Observe again before retrying.`,
      );
      return 1;
    };
    const tenantExit = reportSide("tenant", outcome.tenant);
    const globalExit = reportSide("global", outcome.global);
    return tenantExit === 0 && globalExit === 0 && outcome.ok ? 0 : 1;
  },
};
