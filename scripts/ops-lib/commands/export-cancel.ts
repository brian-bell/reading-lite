// `ops export cancel` (reading-lite-mxwx.9): end one stuck archive export and
// delete its parts, for when the queue cannot (ARCHIVE_EXPORT_JOBS unbound,
// cron not firing) or the tenant's one active slot has to free now.
//
// Row first, then R2. The row is locked, and cancelled only from queued or
// building, with lease_seq bumped: a delivery mid-build then loses its
// compare-and-set and cannot mark the export ready. It also deletes the prefix
// itself once its own writes are done (archive-export.ts standDown), which
// covers a segment written after this command's delete. The delete runs after
// the commit through ContentStore.deletePrefix, the loop the DLQ uses.
//
// A cancelled or failed row only has its prefix swept, so a rerun finishes a
// delete that failed. Ready and expired rows are refused: expiry owns them.

import { parseArgs } from "node:util";
import { ARCHIVE_EXPORT_LEASE_MS } from "../../../src/archive-export";
import { cancelActiveArchiveExports, exportObjectPrefix } from "../../../src/control-plane/archive-exports";
import {
  connectExports,
  describeExport,
  exportContentStore,
  exportParts,
  exportRows,
  isActiveExport,
  requireExportId,
  requireExportTenant,
  type ConnectExports,
} from "../../export-lib/exports";
import { DATABASE_URL_ENV_FLAG_HELP } from "../../pg-lib/operator-db";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { TENANT_FLAG_HELP } from "../tenant-flag";

export interface ExportCancelDeps extends BaseDeps {
  connect: ConnectExports;
  now: () => number;
}

const OPERATOR_CANCELLED = { code: "operator_cancelled" } as const;

type Decision = { kind: "cancelled"; from: string } | { kind: "sweep"; status: string } | { kind: "refused"; status: string | null };

function decide(status: string | null): Decision {
  if (status !== null && isActiveExport(status)) return { kind: "cancelled", from: status };
  if (status === "cancelled" || status === "failed") return { kind: "sweep", status };
  return { kind: "refused", status };
}

export const exportCancelCommand: CommandDefinition<ExportCancelDeps> = {
  group: "export",
  name: "cancel",
  summary: "Cancel a stuck archive export and delete its parts",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- export cancel --tenant <usr_…> --export <exp_…> [--bucket reading-lite-staging] [--execute]

Cancels a queued or building export under its row lock: status cancelled,
error {"code":"operator_cancelled"}, lease_seq bumped so a running delivery
loses its commit. Then deletes every object under its exports/<id>/ prefix.
The tenant's one active slot frees at once, and a cancelled export does not
count toward the daily limit.

A cancelled or failed export only has its prefix swept: rerun after a delete
that failed, or when \`ops export inspect\` shows leftover parts. Ready and
expired exports are refused (exit 1); the */15 cron's expiry owns them.

Plan by default: prints the row and the parts it would delete. --execute acts.

Options:
  ${TENANT_FLAG_HELP}
  --export <exp_…>    REQUIRED. The export to cancel.
  --bucket <name>     reading-lite (default) or reading-lite-staging; names the
                      database too.
${DATABASE_URL_ENV_FLAG_HELP}
  --execute           Cancel and delete. Without it nothing changes.

R2 credentials: CORPUS_R2_ACCESS_KEY/CORPUS_R2_SECRET_KEY or CLOUDFLARE_API_TOKEN,
with CORPUS_R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID (env or .corpus.vars).`,
  defaultDeps: (io) => ({ io, connect: connectExports(), now: () => Date.now() }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          tenant: { type: "string" },
          export: { type: "string" },
          bucket: { type: "string", default: "reading-lite" },
          "database-url-env": { type: "string" },
          execute: { type: "boolean", default: false },
        },
      }));
    } catch (error) {
      throw new UsageError(String(error));
    }
    const tenant = requireExportTenant(values.tenant);
    if (values.export === undefined) throw new UsageError("--export is required");
    const exportId = requireExportId(values.export);
    return deps.connect({ bucket: values.bucket!, databaseUrlEnv: values["database-url-env"] }, async (remote) => {
      const { io } = deps;
      const nowMs = deps.now();
      io.stdout(`Bucket: ${values.bucket}`);
      io.stdout(`Tenant: ${tenant.tenantId}`);
      io.stdout(`Mode: ${values.execute ? "EXECUTE" : "PLAN"}`);
      const [row] = await exportRows(remote.db, tenant.tenantId, exportId);
      const parts = await exportParts(remote.storage, tenant, exportId);
      io.stdout("");
      if (row) {
        for (const line of describeExport(row, parts, { nowMs, leaseMs: ARCHIVE_EXPORT_LEASE_MS })) io.stdout(line);
        io.stdout("");
      }
      const planned = decide(row?.status ?? null);
      if (planned.kind === "refused") return refuse(io, tenant.tenantId, exportId, planned.status);
      const prefix = exportObjectPrefix(exportId);

      if (!values.execute) {
        if (planned.kind === "cancelled") {
          io.stdout(`Would cancel ${exportId} (${planned.from} → cancelled, lease_seq bumped, error operator_cancelled).`);
        } else {
          io.stdout(`${exportId} is already ${planned.status}; the row stays as it is.`);
        }
        io.stdout(`Would delete ${parts.objects} objects under ${tenant.keyRoot}${prefix}/.`);
        io.stdout("\nPLAN — nothing changed. Re-run with --execute to apply.");
        return 0;
      }

      // Decided again under the lock: the row may have moved since the read
      // above (a delivery finished it, expiry, or another cancel).
      const decided = await remote.db.transaction(async (tx) => {
        const locked = await tx.first<{ status: string }>(
          "SELECT status FROM archive_exports WHERE id = ? AND tenant_id = ? FOR UPDATE",
          exportId,
          tenant.tenantId,
        );
        const decision = decide(locked?.status ?? null);
        if (decision.kind === "cancelled") {
          const changed = await cancelActiveArchiveExports(tx, {
            tenantId: tenant.tenantId,
            exportId,
            nowMs,
            error: OPERATOR_CANCELLED,
          });
          if (changed !== 1) throw new Error(`cancelling ${exportId} changed ${changed} rows under its lock`);
        }
        return decision;
      });
      if (decided.kind === "refused") return refuse(io, tenant.tenantId, exportId, decided.status);
      io.stdout(
        decided.kind === "cancelled"
          ? `cancelled ${exportId} (was ${decided.from})`
          : `${exportId} is already ${decided.status}; row unchanged`,
      );

      let deleted: number;
      try {
        deleted = await exportContentStore(remote.storage, tenant).deletePrefix(prefix);
      } catch (error) {
        io.stderr(`✗ deleting ${tenant.keyRoot}${prefix}/ failed: ${error instanceof Error ? error.message : String(error)}`);
        const ended = decided.kind === "cancelled" ? "cancelled" : decided.status;
        io.stderr(`  The row is ${ended}. Re-run the same command with --execute to finish the delete.`);
        return 1;
      }
      io.stdout(`deleted ${deleted} objects under ${tenant.keyRoot}${prefix}/`);
      return 0;
    });
  },
};

function refuse(io: BaseDeps["io"], tenantId: string, exportId: string, status: string | null): number {
  io.stderr(
    status === null
      ? `✗ tenant ${tenantId} has no export ${exportId}`
      : `✗ ${exportId} is ${status}: refusing. The */15 cron's expiry deletes a ready or expired export's parts.`,
  );
  return 1;
}
