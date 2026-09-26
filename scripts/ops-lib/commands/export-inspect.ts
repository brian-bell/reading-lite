// `ops export inspect` (reading-lite-mxwx.9): one tenant's archive exports,
// read-only. Each row's lifecycle fields, lease, cursor, and error, next to
// the parts R2 holds under its prefix. One listing of the tenant's exports/
// root also shows parts whose row is gone, and an ended row that still holds
// parts (which `ops export cancel` sweeps).

import { parseArgs } from "node:util";
import { ARCHIVE_EXPORT_LEASE_MS } from "../../../src/archive-export";
import {
  connectExports,
  describeExport,
  exportParts,
  exportPartsByExport,
  exportRows,
  formatBytes,
  requireExportId,
  requireExportTenant,
  type ConnectExports,
} from "../../export-lib/exports";
import { DATABASE_URL_ENV_FLAG_HELP } from "../../pg-lib/operator-db";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { TENANT_FLAG_HELP } from "../tenant-flag";

export interface ExportInspectDeps extends BaseDeps {
  connect: ConnectExports;
  now: () => number;
}

export const exportInspectCommand: CommandDefinition<ExportInspectDeps> = {
  group: "export",
  name: "inspect",
  summary: "Show a tenant's archive exports and the parts R2 holds for each",
  safety: "read-only",
  helpText: `Usage: npm run ops -- export inspect --tenant <usr_…> [--export <exp_…>] [--bucket reading-lite-staging]

Prints each archive export row, newest first: status, requested/started/
updated/completed/expires times, lease_seq, continuations, cursor, error, and
the object count and bytes under its exports/<id>/ prefix. A queued or building
row also shows how long it has been idle against the cron's 30-minute lease.
Parts with no row are listed at the end.

Options:
  ${TENANT_FLAG_HELP}
  --export <exp_…>    Only this export. Exit 1 when the tenant has no such row.
  --bucket <name>     reading-lite (default) or reading-lite-staging; names the
                      database too.
${DATABASE_URL_ENV_FLAG_HELP}

R2 credentials: CORPUS_R2_ACCESS_KEY/CORPUS_R2_SECRET_KEY or CLOUDFLARE_API_TOKEN,
with CORPUS_R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID (env or .corpus.vars).
Never changes a row or an object.`,
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
        },
      }));
    } catch (error) {
      throw new UsageError(String(error));
    }
    const tenant = requireExportTenant(values.tenant);
    const exportId = values.export === undefined ? undefined : requireExportId(values.export);
    return deps.connect({ bucket: values.bucket!, databaseUrlEnv: values["database-url-env"] }, async (remote) => {
      const { io } = deps;
      const rows = await exportRows(remote.db, tenant.tenantId, exportId);
      // One export's own prefix when named; the whole exports/ root otherwise,
      // which also finds parts with no row.
      const parts =
        exportId === undefined
          ? await exportPartsByExport(remote.storage, tenant)
          : new Map([[exportId, await exportParts(remote.storage, tenant, exportId)]]);
      io.stdout(`Bucket: ${values.bucket}`);
      io.stdout(`Tenant: ${tenant.tenantId}`);
      if (exportId !== undefined && rows.length === 0) {
        io.stderr(`✗ tenant ${tenant.tenantId} has no export ${exportId}`);
        const orphan = parts.get(exportId);
        if (orphan && orphan.objects > 0) io.stderr(`  but ${orphan.objects} objects (${formatBytes(orphan.bytes)}) remain under its prefix`);
        return 1;
      }
      if (rows.length === 0) io.stdout("No archive exports.");
      const nowMs = deps.now();
      for (const row of rows) {
        io.stdout("");
        const held = parts.get(row.id) ?? { objects: 0, bytes: 0 };
        for (const line of describeExport(row, held, { nowMs, leaseMs: ARCHIVE_EXPORT_LEASE_MS })) io.stdout(line);
        if ((row.status === "cancelled" || row.status === "failed") && held.objects > 0) {
          io.stdout(
            `  leftover parts: npm run ops -- export cancel --tenant ${tenant.tenantId} --export ${row.id} ` +
              `--bucket ${values.bucket} --execute deletes them`,
          );
        }
      }
      if (exportId === undefined) {
        const known = new Set(rows.map((row) => row.id));
        const orphans = [...parts].filter(([id]) => !known.has(id));
        if (orphans.length > 0) {
          io.stdout("");
          io.stdout("Parts with no archive_exports row:");
          for (const [id, held] of orphans) io.stdout(`  ${id}: ${held.objects} objects (${formatBytes(held.bytes)})`);
        }
      }
      return 0;
    });
  },
};
