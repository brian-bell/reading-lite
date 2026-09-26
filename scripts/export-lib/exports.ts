// Operator access to archive exports (reading-lite-mxwx.9), shared by
// `ops export inspect` and `ops export cancel`.
//
// The row is read and changed through the operator-db pairing: the bucket
// names the database, never a guess. The parts are listed and deleted through
// the operator's R2 inventory client, wrapped as the two R2Bucket calls
// ContentStore.deletePrefix makes, so a cancel deletes with the same
// list-until-empty loop the DLQ and the consumer use. The prefix spelling
// comes from exportObjectPrefix and the tenant root from tenantKeyRoot.

import { ArchiveExportCursorSchema, exportObjectPrefix } from "../../src/control-plane/archive-exports";
import type { ControlPlaneDb } from "../../src/control-plane/db";
import { parseExportId } from "../../src/control-plane/export-envelope";
import { fromTimestamp } from "../../src/control-plane/pg-time";
import { ContentStore } from "../../src/modules/stores/content-store";
import { r2InventoryClientFromVars, type R2ObjectMeta } from "../lib/cf-clients";
import { loadDotVars } from "../lib/dotvars";
import type { OperatorTenant } from "../corpus-lib/tenant";
import { UsageError } from "../ops-lib/contract";
import { requireOperatorTenant } from "../ops-lib/tenant-flag";
import { resolveOperatorDatabaseUrl, withOperatorControlPlane } from "../pg-lib/operator-db";

export interface ExportStorage {
  listObjects(prefix: string): Promise<Pick<R2ObjectMeta, "key" | "size">[]>;
  delete(key: string): Promise<void>;
}

export interface ExportRemote {
  db: ControlPlaneDb;
  storage: ExportStorage;
}

export interface ConnectExportsArgs {
  bucket: string;
  databaseUrlEnv?: string | undefined;
}

// Runs `work` against the bucket's database and objects. The session's
// lifetime is withOperatorControlPlane's, closed on every exit path.
export type ConnectExports = <T>(args: ConnectExportsArgs, work: (remote: ExportRemote) => Promise<T>) => Promise<T>;

// The connection string resolves before anything opens, so an unmapped bucket
// or a missing variable stops the command with no traffic at all.
export function connectExports(
  vars: Record<string, string | undefined> = { ...loadDotVars(".corpus.vars"), ...process.env },
): ConnectExports {
  return (args, work) => {
    const { url } = resolveOperatorDatabaseUrl({ bucket: args.bucket, databaseUrlEnv: args.databaseUrlEnv, env: vars });
    const storage = r2InventoryClientFromVars(vars, args.bucket);
    return withOperatorControlPlane(url, (db) => work({ db, storage }));
  };
}

export type ExportTenant = Extract<OperatorTenant, { kind: "tenant" }>;

// Exports only exist under a tenant's root, so 'global' is refused here after
// the shared selector check.
export function requireExportTenant(selector: string | undefined): ExportTenant {
  const tenant = requireOperatorTenant(selector);
  if (tenant.kind !== "tenant") {
    throw new UsageError("--tenant global has no archive exports: pass the tenant id (usr_…)");
  }
  return tenant;
}

export function requireExportId(value: string | undefined): string {
  const id = parseExportId(value ?? "");
  if (!id) throw new UsageError(`malformed --export: ${JSON.stringify(value ?? "")} (expected exp_…)`);
  return id;
}

// ContentStore takes a Worker R2Bucket. deletePrefix calls only list and
// delete, so these two over the inventory client are enough; the listing is
// already complete (the client pages), and deletePrefix re-lists until empty.
function operatorBucket(storage: ExportStorage): R2Bucket {
  const bucket: Pick<R2Bucket, "list" | "delete"> = {
    list: async (options) => {
      const objects = await storage.listObjects(options?.prefix ?? "");
      return { objects, truncated: false, delimitedPrefixes: [] } as unknown as R2Objects;
    },
    delete: async (keys) => {
      for (const key of typeof keys === "string" ? [keys] : keys) await storage.delete(key);
    },
  };
  return bucket as R2Bucket;
}

export function exportContentStore(storage: ExportStorage, tenant: ExportTenant): ContentStore {
  return new ContentStore(operatorBucket(storage), tenant.keyRoot);
}

export interface ExportParts {
  objects: number;
  bytes: number;
}

// One listing of the tenant's exports/ root, grouped by export id. It also
// finds parts whose row is gone.
export async function exportPartsByExport(
  storage: ExportStorage,
  tenant: ExportTenant,
): Promise<Map<string, ExportParts>> {
  const root = `${tenant.keyRoot}${exportObjectPrefix("")}`;
  const parts = new Map<string, ExportParts>();
  for (const object of await storage.listObjects(root)) {
    const id = object.key.slice(root.length).split("/")[0] ?? "";
    const entry = parts.get(id) ?? { objects: 0, bytes: 0 };
    entry.objects += 1;
    entry.bytes += object.size;
    parts.set(id, entry);
  }
  return parts;
}

export async function exportParts(storage: ExportStorage, tenant: ExportTenant, exportId: string): Promise<ExportParts> {
  const objects = await storage.listObjects(`${tenant.keyRoot}${exportObjectPrefix(exportId)}/`);
  return { objects: objects.length, bytes: objects.reduce((total, object) => total + object.size, 0) };
}

export interface ExportRow {
  id: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  updated_at: string;
  lease_seq: number;
  continuations: number;
  cursor: unknown;
  segments: unknown;
  error: unknown;
}

const ROW_COLUMNS = `id, status, requested_at, started_at, completed_at, expires_at, updated_at,
  lease_seq, continuations, cursor, segments, error`;

export function exportRows(db: ControlPlaneDb, tenantId: string, exportId?: string): Promise<ExportRow[]> {
  return db.all<ExportRow>(
    `SELECT ${ROW_COLUMNS} FROM archive_exports
     WHERE tenant_id = ? AND (?::text IS NULL OR id = ?)
     ORDER BY requested_at DESC`,
    tenantId,
    exportId ?? null,
    exportId ?? null,
  );
}

export function isActiveExport(status: string): boolean {
  return status === "queued" || status === "building";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function iso(value: string | null): string {
  return value === null ? "-" : new Date(fromTimestamp(value)).toISOString();
}

// The lines inspect prints per row, and cancel prints for the row it acts on.
export function describeExport(
  row: ExportRow,
  parts: ExportParts,
  input: { nowMs: number; leaseMs: number },
): string[] {
  const lines = [
    `${row.id}  ${row.status}`,
    `  requested ${iso(row.requested_at)}  started ${iso(row.started_at)}  updated ${iso(row.updated_at)}`,
    `  completed ${iso(row.completed_at)}  expires ${iso(row.expires_at)}`,
    `  lease_seq ${row.lease_seq}  continuations ${row.continuations}`,
  ];
  if (isActiveExport(row.status)) {
    const idleMs = input.nowMs - fromTimestamp(row.updated_at);
    const idle = `${Math.floor(idleMs / 60_000)}m`;
    lines.push(
      idleMs >= input.leaseMs
        ? `  idle ${idle}: past the ${input.leaseMs / 60_000}m lease; the */15 cron should have resent it by ` +
            `${input.leaseMs / 60_000 + 15}m, so idle well past that means the cron is not firing or ` +
            `ARCHIVE_EXPORT_JOBS is unbound`
        : `  idle ${idle}: inside the ${input.leaseMs / 60_000}m lease`,
    );
  }
  if (row.cursor === null) {
    lines.push("  cursor: none (no segment committed)");
  } else {
    const cursor = ArchiveExportCursorSchema.safeParse(row.cursor);
    lines.push(
      cursor.success
        ? `  cursor: phase ${cursor.data.phase}, ${cursor.data.entries} entries, ` +
            `offset ${cursor.data.offset}, ${cursor.data.segments.length} segments`
        : `  cursor: unreadable ${JSON.stringify(row.cursor)}`,
    );
  }
  lines.push(`  error: ${row.error === null ? "-" : JSON.stringify(row.error)}`);
  lines.push(`  parts: ${parts.objects} objects (${formatBytes(parts.bytes)})`);
  return lines;
}
