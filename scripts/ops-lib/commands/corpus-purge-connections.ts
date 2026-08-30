// `ops corpus purge-connections` — remove dangling inbound connection entries
// for one already-deleted reading. This is deliberately an offline, plan-first
// full-corpus sweep: DELETE stays latency-bounded and the data model gains no
// reverse index or tombstone.

import { parseArgs } from "node:util";
import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import { parseReadingId } from "../../../src/services";
import {
  buildKeyPrefix,
  MANIFEST_FILE,
  r2KeyLayout,
} from "../../../src/modules/stores/layout";
import { loadDotVars } from "../../lib/dotvars";
import type { R2ObjectMeta } from "../../lib/cf-clients";
import { resolveBucket } from "../../corpus-lib/config";
import { operatorTenantSelector } from "../../corpus-lib/tenant";
import { soleWriterGuard } from "../../corpus-lib/sole-writer";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";
import { requireOperatorTenant } from "../tenant-flag";

const MAX_CAS_CONFLICTS = 3;

export interface PurgeConnectionsStorage {
  head(key: string): Promise<boolean>;
  listObjects(prefix: string): Promise<R2ObjectMeta[]>;
  get(key: string): Promise<string | null>;
  putIfMatch(key: string, body: string, etag: string): Promise<boolean>;
}

export interface CorpusPurgeConnectionsDeps extends BaseDeps {
  createStorage: (bucket: string) => Promise<PurgeConnectionsStorage>;
}

interface Args {
  bucket: string;
  tenant?: string;
  id: string;
  execute: boolean;
  soleWriter: boolean;
}

interface ParsedManifest {
  key: string;
  etag: string;
  raw: Record<string, unknown>;
  manifest: Manifest;
}

interface Audit {
  mode: "plan" | "execute";
  tenant: string;
  tenant_audit_stamp: { tenant_id: string } | null;
  target_id: string;
  manifests_scanned: number;
  manifests_matched: number;
  matching_entries_found: number;
  manifests_would_write: number;
  manifests_written: number;
  unchanged_manifests: number;
  conflicts: number;
  retries: number;
  failures: number;
  partial_execution: boolean;
  failure_code: "invalid_target" | "target_present" | "manifest_invalid" | "cas_exhausted" | "storage_error" | null;
  failure_stage: FailureStage | null;
}

type FailureStage =
  | "validate_target"
  | "storage_init"
  | "check_target"
  | "list_manifests"
  | "read_manifest"
  | "validate_manifest"
  | "write_manifest";

interface RunContext {
  stage: FailureStage;
}

type ScanResult =
  | { ok: true; rows: ParsedManifest[] }
  | { ok: false; error: string; code: "manifest_invalid" };

type AbsenceResult =
  | { ok: true; rows: ParsedManifest[] }
  | { ok: false; error: string; code: "target_present" | "manifest_invalid" };

function parsePurgeArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bucket: { type: "string" },
        tenant: { type: "string" },
        id: { type: "string" },
        execute: { type: "boolean", default: false },
        "sole-writer": { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (!values.id) throw new UsageError("--id is required");
  return {
    bucket: resolveBucket(values.bucket),
    ...(values.tenant === undefined ? {} : { tenant: values.tenant }),
    id: values.id,
    execute: values.execute === true,
    soleWriter: values["sole-writer"] === true,
  };
}

function matchingCount(manifest: Manifest, targetId: string): number {
  return manifest.connections?.filter((connection) => connection.id === targetId).length ?? 0;
}

function rewrittenRaw(row: ParsedManifest, targetId: string): Record<string, unknown> {
  return {
    ...row.raw,
    connections: row.manifest.connections?.filter((connection) => connection.id !== targetId) ?? [],
  };
}

function canonicalManifestReadingId(
  layout: ReturnType<typeof r2KeyLayout>,
  objectKey: string,
): string | null {
  const parts = layout.relativeKey(objectKey).split("/");
  if (parts.length !== 5 || parts[0] !== "readings" || parts[4] !== MANIFEST_FILE) {
    return null;
  }
  const [year, month, leaf] = [parts[1]!, parts[2]!, parts[3]!];
  if (leaf.length < 12 || leaf[2] !== "T" || leaf[9] !== "Z" || leaf[10] !== "-") {
    return null;
  }
  const readingId = leaf.slice(11);
  if (parseReadingId(readingId) !== readingId) return null;

  const createdAt =
    `${year}-${month}-${leaf.slice(0, 2)}T` +
    `${leaf.slice(3, 5)}:${leaf.slice(5, 7)}:${leaf.slice(7, 9)}.000Z`;
  try {
    const expectedKey = layout.manifestKey(buildKeyPrefix(readingId, createdAt));
    return expectedKey === objectKey ? readingId : null;
  } catch {
    return null;
  }
}

async function scanManifests(
  storage: PurgeConnectionsStorage,
  layout: ReturnType<typeof r2KeyLayout>,
  context: RunContext,
): Promise<ScanResult> {
  context.stage = "list_manifests";
  const objects = (await storage.listObjects(layout.readingsPrefix()))
    .map((object) => ({ object, readingId: canonicalManifestReadingId(layout, object.key) }))
    .filter(
      (candidate): candidate is { object: R2ObjectMeta; readingId: string } =>
        candidate.readingId !== null,
    )
    .sort((a, b) => a.object.key.localeCompare(b.object.key));
  const rows: ParsedManifest[] = [];
  for (const { object, readingId } of objects) {
    if (!object.etag) {
      return { ok: false, code: "manifest_invalid", error: `manifest lacks an ETag witness: ${object.key}` };
    }
    context.stage = "read_manifest";
    const text = await storage.get(object.key);
    if (text === null) {
      return { ok: false, code: "manifest_invalid", error: `manifest disappeared during scan: ${object.key}` };
    }
    context.stage = "validate_manifest";
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: "manifest_invalid",
        error: `malformed manifest ${object.key}: invalid JSON`,
      };
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        code: "manifest_invalid",
        error: `malformed manifest ${object.key}: schema validation failed`,
      };
    }
    if (parseReadingId(parsed.data.id) !== parsed.data.id || parsed.data.id !== readingId) {
      return {
        ok: false,
        code: "manifest_invalid",
        error: `malformed manifest ${object.key}: manifest id is invalid or does not match its key`,
      };
    }
    const expectedKey = layout.manifestKey(buildKeyPrefix(parsed.data.id, parsed.data.created_at));
    if (object.key !== expectedKey) {
      return {
        ok: false,
        code: "manifest_invalid",
        error: `malformed manifest ${object.key}: key does not match manifest id and created_at`,
      };
    }
    rows.push({ key: object.key, etag: object.etag, raw: raw as Record<string, unknown>, manifest: parsed.data });
  }
  return { ok: true, rows };
}

async function proveTargetAbsent(
  storage: PurgeConnectionsStorage,
  layout: ReturnType<typeof r2KeyLayout>,
  targetId: string,
  context: RunContext,
): Promise<AbsenceResult> {
  context.stage = "check_target";
  if (await storage.head(layout.byIdKey(targetId))) {
    return {
      ok: false,
      code: "target_present",
      error: `target ${targetId} exists at ${layout.byIdKey(targetId)}`,
    };
  }
  const scan = await scanManifests(storage, layout, context);
  if (!scan.ok) return scan;
  const target = scan.rows.find((row) => row.manifest.id === targetId);
  if (target) {
    context.stage = "check_target";
    return {
      ok: false,
      code: "target_present",
      error: `target ${targetId} exists in manifest ${target.key}`,
    };
  }
  return scan;
}

function emitAudit(io: CommandIo, audit: Audit): void {
  audit.partial_execution = audit.failures > 0 && audit.manifests_written > 0;
  io.stdout(JSON.stringify(audit));
}

function recordFailure(
  audit: Audit,
  code: Exclude<Audit["failure_code"], null>,
  stage: FailureStage,
): void {
  audit.failures += 1;
  audit.failure_code = code;
  audit.failure_stage = stage;
}

async function executePurge(
  args: Args,
  deps: CorpusPurgeConnectionsDeps,
  tenant: ReturnType<typeof requireOperatorTenant>,
  audit: Audit,
  context: RunContext,
): Promise<number> {
  context.stage = "storage_init";
  const storage = await deps.createStorage(args.bucket);
  const layout = r2KeyLayout(tenant.keyRoot);
  const preflight = await proveTargetAbsent(storage, layout, args.id, context);
  if (!preflight.ok) {
    recordFailure(audit, preflight.code, context.stage);
    deps.io.stderr(`REFUSED: ${preflight.error}`);
    return 1;
  }

  audit.manifests_scanned = preflight.rows.length;
  const planned = preflight.rows.filter((row) => matchingCount(row.manifest, args.id) > 0);
  audit.manifests_matched = planned.length;
  audit.matching_entries_found = planned.reduce((sum, row) => sum + matchingCount(row.manifest, args.id), 0);
  audit.manifests_would_write = planned.length;
  audit.unchanged_manifests = preflight.rows.length - planned.length;

  if (!args.execute || planned.length === 0) return 0;

  const soleWriter = soleWriterGuard({
    execute: true,
    acknowledged: true,
    tool: "ops corpus purge-connections",
  });
  if (soleWriter.message) deps.io.stderr(soleWriter.message);

  // Refresh every witness immediately before the first mutation. This both
  // re-proves target absence and prevents an avoidable CAS loss on a manifest
  // changed between planning and execution.
  const mutationScan = await proveTargetAbsent(storage, layout, args.id, context);
  if (!mutationScan.ok) {
    recordFailure(audit, mutationScan.code, context.stage);
    deps.io.stderr(`REFUSED before mutation: ${mutationScan.error}`);
    return 1;
  }
  const currentByKey = new Map(mutationScan.rows.map((row) => [row.key, row]));

  for (const plannedRow of planned) {
    let row = currentByKey.get(plannedRow.key);
    if (!row) {
      audit.unchanged_manifests += 1;
      continue;
    }
    if (matchingCount(row.manifest, args.id) === 0) {
      audit.unchanged_manifests += 1;
      continue;
    }

    let conflictsForManifest = 0;
    while (true) {
      context.stage = "write_manifest";
      const wrote = await storage.putIfMatch(
        row.key,
        JSON.stringify(rewrittenRaw(row, args.id), null, 2) + "\n",
        row.etag,
      );
      if (wrote) {
        audit.manifests_written += 1;
        break;
      }

      audit.conflicts += 1;
      conflictsForManifest += 1;
      if (conflictsForManifest > MAX_CAS_CONFLICTS) {
        recordFailure(audit, "cas_exhausted", "write_manifest");
        deps.io.stderr(`CAS retries exhausted for ${row.key}; no blind overwrite performed`);
        return 1;
      }

      const retryScan = await proveTargetAbsent(storage, layout, args.id, context);
      if (!retryScan.ok) {
        recordFailure(audit, retryScan.code, context.stage);
        deps.io.stderr(`REFUSED during CAS retry: ${retryScan.error}`);
        return 1;
      }
      const newest = retryScan.rows.find((candidate) => candidate.key === row!.key);
      if (!newest || matchingCount(newest.manifest, args.id) === 0) {
        audit.unchanged_manifests += 1;
        break;
      }
      row = newest;
      audit.retries += 1;
    }
  }

  return 0;
}

async function runCorpusPurgeConnections(argv: string[], deps: CorpusPurgeConnectionsDeps): Promise<number> {
  const args = parsePurgeArgs(argv);
  const tenant = requireOperatorTenant(args.tenant);
  const selector = operatorTenantSelector(tenant);
  const audit: Audit = {
    mode: args.execute ? "execute" : "plan",
    tenant: selector,
    tenant_audit_stamp: tenant.kind === "tenant" ? { tenant_id: tenant.tenantId } : null,
    target_id: args.id,
    manifests_scanned: 0,
    manifests_matched: 0,
    matching_entries_found: 0,
    manifests_would_write: 0,
    manifests_written: 0,
    unchanged_manifests: 0,
    conflicts: 0,
    retries: 0,
    failures: 0,
    partial_execution: false,
    failure_code: null,
    failure_stage: null,
  };

  if (parseReadingId(args.id) !== args.id) {
    recordFailure(audit, "invalid_target", "validate_target");
    deps.io.stderr("REFUSED: --id must be a valid reading id");
    emitAudit(deps.io, audit);
    return 2;
  }

  if (args.execute && !args.soleWriter) {
    const verdict = soleWriterGuard({
      execute: true,
      acknowledged: false,
      tool: "ops corpus purge-connections",
    });
    if (verdict.message) deps.io.stderr(verdict.message);
    throw new UsageError("--execute requires --sole-writer");
  }

  const context: RunContext = { stage: "storage_init" };
  let code: number;
  try {
    code = await executePurge(args, deps, tenant, audit, context);
  } catch {
    recordFailure(audit, "storage_error", context.stage);
    deps.io.stderr(`purge-connections storage operation failed during ${context.stage}`);
    code = 1;
  }
  emitAudit(deps.io, audit);
  return code;
}

export const corpusPurgeConnectionsCommand: CommandDefinition<CorpusPurgeConnectionsDeps> = {
  group: "corpus",
  name: "purge-connections",
  summary: "Remove dangling inbound connections to one deleted reading",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- corpus purge-connections --tenant <selector> --id <reading-id> [options]

Scans and validates every manifest in the explicitly selected tenant corpus,
then removes connection entries whose bare id exactly matches the deleted
reading id. The target must already be absent. Plans by default.

Options:
  --id <reading-id>     REQUIRED: deleted bare reading id to remove from connections.
  --tenant <selector>   REQUIRED: tenant id (usr_…) or 'global' for pre-tenant data.
  --bucket <name>       R2 bucket. Default: READING_LITE_BUCKET / reading-lite.
  --execute             Apply the plan; requires --sole-writer.
  --sole-writer         Assert that no ingestion, reprocessing, deletion, or
                        recreation can mutate this corpus for the entire run.
  --help                Show this message.`,
  defaultDeps: (io: CommandIo): CorpusPurgeConnectionsDeps => ({
    io,
    createStorage: async (bucket) => {
      const { r2InventoryClientFromVars } = await import("../../lib/cf-clients");
      const vars = {
        ...loadDotVars(".corpus.vars"),
        ...process.env,
      };
      const client = r2InventoryClientFromVars(vars, bucket);
      return {
        head: (key) => client.head(key),
        listObjects: (prefix) => client.listObjects(prefix),
        get: (key) => client.get(key),
        putIfMatch: (key, body, etag) =>
          client.putIfMatch(key, body, etag, { contentType: "application/json" }),
      };
    },
  }),
  run: runCorpusPurgeConnections,
};
