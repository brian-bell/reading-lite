// `ops migrate import`'s body (reading-lite-gh348): load a frozen snapshot
// into an EMPTY PostgreSQL database, in one transaction, and prove the result
// before committing it.
//
// This is deliberately not a resumable migration system. The target must
// already carry the #347 schema (every db/migrations file applied, pgvector
// installed) and hold no application row at all; anything else is refused.
// A failure anywhere rolls the whole import back, so the target is either
// untouched or complete, and a retry starts from the same empty database.
//
// Proof, inside the transaction and before COMMIT:
//   - every reading read back through the reading store equals the manifest
//     the snapshot predicts (expectedManifest), field for field;
//   - per-field totals and hashes over that read-back equal the snapshot's;
//   - every embedding reads back as the float4 rounding of its source;
//   - every control-plane row reads back equal to its D1 source, converted.
// Any mismatch throws, and nothing is committed.
//
// The report is a pure function of the snapshot, the accepted codes and the
// rows written, with no timestamp or connection detail in it, so the same
// snapshot imported into another empty database reports identically.

import { ProcessingAttemptSchema, type Manifest, type ProcessingAttempt } from "../../src/schemas/manifest";
import type { Sql, SqlQuery } from "../../src/modules/db/sql";
import { PgReadingStore } from "../../src/modules/stores/postgres/reading-store";
import { legacyContentKeys, manifestToRows, upsertAttempt, writeReadingRows, type ReadingRows } from "../pg-lib/manifest-rows";
import { planMigrations, readMigrations, MigrationDriftError, type MigrationFile } from "../pg-lib/migrate";
import {
  CONTROL_PLANE_TABLES,
  comparableRow,
  insertControlPlaneRows,
  readControlPlaneTable,
} from "./control-plane-map";
import {
  BLOCKING_CODES,
  blockingIssues,
  differingFields,
  expectedManifest,
  fieldTotals,
  isUnresolved,
  parseEntry,
  sameManifest,
  sortDiscrepancies,
  vectorProblem,
  type BlockingCode,
  type Discrepancy,
} from "./library-checks";
import { canonicalHash, canonicalJson, type Snapshot } from "./snapshot";

// Serialises two imports racing at one target; the loser then finds rows and
// refuses. Arbitrary constant, like the migration runner's.
const IMPORT_LOCK_KEY = 348_001;

const MIGRATIONS_TABLE = "schema_migrations";

export interface TargetState {
  vectorExtension: string | null;
  pendingMigrations: string[];
  drift: string | null;
  nonEmptyTables: string[];
}

export function targetRefusals(state: TargetState): string[] {
  const out: string[] = [];
  if (state.drift) out.push(`migration drift: ${state.drift}`);
  if (state.pendingMigrations.length > 0) {
    out.push(`migrations not applied: ${state.pendingMigrations.join(", ")} (run \`ops db migrate\` against it first)`);
  }
  if (state.vectorExtension === null) out.push("the vector extension is not installed");
  if (state.nonEmptyTables.length > 0) {
    out.push(`target is not empty: rows in ${state.nonEmptyTables.join(", ")}. The importer only loads an empty database`);
  }
  return out;
}

async function applicationTables(tx: SqlQuery): Promise<string[]> {
  const rows = await tx.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename <> $1 ORDER BY tablename`,
    [MIGRATIONS_TABLE],
  );
  return rows.map((r) => r.name);
}

async function nonEmptyTables(tx: SqlQuery): Promise<string[]> {
  const out: string[] = [];
  for (const table of await applicationTables(tx)) {
    const [row] = await tx.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM "${table}") AS any`);
    if (row!.any) out.push(table);
  }
  return out;
}

/** Read-only: safe for plan mode. */
export async function inspectTarget(sql: SqlQuery, migrations: MigrationFile[] = readMigrations()): Promise<TargetState> {
  const [ext] = await sql.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  let pendingMigrations: string[] = [];
  let drift: string | null = null;
  try {
    const plan = await planMigrations({ query: async (text, values) => ({ rows: await sql.query(text, values) }) }, migrations);
    pendingMigrations = plan.pending.map((file) => `${file.version}_${file.name}`);
  } catch (error) {
    if (!(error instanceof MigrationDriftError)) throw error;
    drift = error.message;
  }
  // Tables are only meaningful once the schema is there; an unmigrated target
  // is already refused above.
  const nonEmpty = pendingMigrations.length === 0 && drift === null ? await nonEmptyTables(sql) : [];
  return { vectorExtension: ext?.extversion ?? null, pendingMigrations, drift, nonEmptyTables: nonEmpty };
}

interface PlannedReading {
  rows: ReadingRows;
  attempts: ProcessingAttempt[];
  expected: Manifest;
}

export interface ImportPlan {
  tenantId: string;
  readings: PlannedReading[];
  controlPlane: Record<string, Record<string, unknown>[]>;
  skipped: { id: string; key_prefix: string; code: BlockingCode }[];
  accepted: BlockingCode[];
  unaccepted: Discrepancy[];
  blocking: Discrepancy[];
  findings: Discrepancy[];
}

export class ImportPlanError extends Error {}

export function planImport(snapshot: Snapshot, accept: ReadonlySet<BlockingCode>): ImportPlan {
  const tenantId = snapshot.meta.tenant_id;
  const blocking = blockingIssues(snapshot.library, snapshot.controlPlane, tenantId);
  const unaccepted = blocking.filter((d) => !accept.has(d.code as BlockingCode));
  const codesById = new Map<string, Set<string>>();
  for (const d of blocking) if (d.id) codesById.set(d.id, new Set([...(codesById.get(d.id) ?? []), d.code]));

  const readings: PlannedReading[] = [];
  const skipped: ImportPlan["skipped"] = [];
  const findings: Discrepancy[] = [];
  const owners = new Map<string, string>();
  for (const entry of snapshot.library.readings) {
    const parsed = parseEntry(entry);
    if (!parsed.ok) {
      skipped.push({ id: entry.id, key_prefix: entry.key_prefix, code: "malformed_manifest" });
      continue;
    }
    if (codesById.get(entry.id)?.has("tombstoned_manifest")) {
      skipped.push({ id: entry.id, key_prefix: entry.key_prefix, code: "tombstoned_manifest" });
      continue;
    }
    const manifest = parsed.manifest;
    const embedding =
      // Owners only, as PgReadingWriter.publish stores them.
      manifest.status === "ready" && entry.owns_url && entry.embedding !== null && vectorProblem(entry.embedding.values) === null
        ? entry.embedding.values
        : undefined;
    const revision =
      entry.raw_key === undefined
        ? undefined
        : { id: `rev_${manifest.id}`, rawKey: entry.raw_key, extractedKey: legacyContentKeys(entry.key_prefix, manifest).extractedKey };
    const rows = manifestToRows(manifest, { tenantId, keyPrefix: entry.key_prefix, ownsUrl: entry.owns_url, embedding, revision });
    if (entry.owns_url) {
      const previous = owners.get(manifest.url_hash);
      if (previous !== undefined) {
        throw new ImportPlanError(`snapshot names two owners for url_hash ${manifest.url_hash}: ${previous} and ${entry.id}`);
      }
      owners.set(manifest.url_hash, entry.id);
    }
    const attempts = entry.attempts.map((raw) => {
      const attempt = ProcessingAttemptSchema.safeParse(raw);
      if (!attempt.success || attempt.data.reading_id !== entry.id) {
        throw new ImportPlanError(`snapshot attempt log for ${entry.id} does not parse; re-export`);
      }
      return attempt.data;
    });
    if (isUnresolved(manifest)) {
      findings.push({ code: "imported_not_runnable", id: entry.id, detail: "no reading_jobs row: nothing will run this attempt" });
    }
    readings.push({ rows, attempts, expected: expectedManifest(manifest) });
  }
  const imported = new Set(readings.map((r) => r.rows.reading.id));
  for (const { rows } of readings) {
    for (const rel of rows.relationships) {
      if (!imported.has(rel.target_id)) {
        findings.push({ code: "dangling_relationship", id: rows.reading.id, detail: `${rel.kind} target ${rel.target_id}` });
      }
    }
  }
  return {
    tenantId,
    readings,
    controlPlane: snapshot.controlPlane.tables,
    skipped,
    accepted: [...accept].sort(),
    unaccepted,
    blocking,
    findings: sortDiscrepancies(findings),
  };
}

export interface ImportReport {
  version: 1;
  snapshot: { tenant_id: string; source: Snapshot["meta"]["source"]; exported_at: string; files: Record<string, string> };
  accepted: string[];
  skipped: ImportPlan["skipped"];
  findings: Discrepancy[];
  rows: Record<string, number>;
  table_sha256: Record<string, string>;
  verification: {
    readings_checked: number;
    manifest_mismatches: { id: string; fields: string[] }[];
    field_totals_match: boolean;
    field_totals_sha256: string;
    embeddings_checked: number;
    embedding_mismatches: string[];
    control_plane_mismatches: { table: string; detail: string }[];
  };
}

export class ImportVerificationError extends Error {
  constructor(readonly report: ImportReport) {
    super("import verification failed; the transaction was rolled back");
  }
}

export class TargetRefusedError extends Error {}

export async function executeImport(sql: Sql, snapshot: Snapshot, plan: ImportPlan): Promise<ImportReport> {
  if (plan.unaccepted.length > 0) {
    throw new TargetRefusedError(`${plan.unaccepted.length} blocking finding(s) are not accepted`);
  }
  return sql.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [IMPORT_LOCK_KEY]);
    // Checked again under the lock: plan mode's look is advisory.
    const nonEmpty = await nonEmptyTables(tx);
    if (nonEmpty.length > 0) throw new TargetRefusedError(`target is not empty: rows in ${nonEmpty.join(", ")}`);

    for (const spec of CONTROL_PLANE_TABLES) await insertControlPlaneRows(tx, spec, plan.controlPlane[spec.table] ?? []);
    for (const reading of plan.readings) {
      await writeReadingRows(tx, reading.rows);
      for (const attempt of reading.attempts) await upsertAttempt(tx, plan.tenantId, attempt);
    }

    const report = await verify(tx, snapshot, plan);
    const v = report.verification;
    if (
      v.manifest_mismatches.length > 0 ||
      !v.field_totals_match ||
      v.embedding_mismatches.length > 0 ||
      v.control_plane_mismatches.length > 0
    ) {
      throw new ImportVerificationError(report);
    }
    return report;
  });
}

async function verify(tx: SqlQuery, snapshot: Snapshot, plan: ImportPlan): Promise<ImportReport> {
  const store = new PgReadingStore(tx, plan.tenantId);
  const manifestMismatches: ImportReport["verification"]["manifest_mismatches"] = [];
  const projected: Manifest[] = [];
  for (const reading of plan.readings) {
    const loaded = await store.loadReadingById(reading.rows.reading.id);
    if (!loaded) {
      manifestMismatches.push({ id: reading.rows.reading.id, fields: ["<row missing>"] });
      continue;
    }
    projected.push(loaded.manifest);
    if (!sameManifest(loaded.manifest, reading.expected)) {
      manifestMismatches.push({ id: reading.rows.reading.id, fields: differingFields(loaded.manifest, reading.expected) });
    }
  }
  const expectedTotals = fieldTotals(plan.readings.map((r) => r.expected));
  const actualTotals = fieldTotals(projected);

  // pgvector stores float4 and prints each component as the shortest decimal
  // that names that float4, so both sides are compared after rounding to
  // float32; anything else is a wrong vector.
  const embeddingMismatches: string[] = [];
  const stored = new Map(
    (
      await tx.query<{ reading_id: string; embedding: string }>(
        "SELECT reading_id, embedding::text AS embedding FROM reading_embeddings WHERE tenant_id = $1",
        [plan.tenantId],
      )
    ).map((row) => [row.reading_id, JSON.parse(row.embedding) as number[]]),
  );
  let embeddingsChecked = 0;
  for (const { rows } of plan.readings) {
    const want = rows.embedding;
    const got = stored.get(rows.reading.id);
    if (want === null) {
      if (got !== undefined) embeddingMismatches.push(rows.reading.id);
      continue;
    }
    embeddingsChecked++;
    if (!got || got.length !== want.length || got.some((value, i) => Math.fround(value) !== Math.fround(want[i]!))) {
      embeddingMismatches.push(rows.reading.id);
    }
  }

  const controlPlaneMismatches: ImportReport["verification"]["control_plane_mismatches"] = [];
  for (const spec of CONTROL_PLANE_TABLES) {
    const source = (plan.controlPlane[spec.table] ?? []).map((row) => canonicalJson(comparableRow(spec, row, "d1"))).sort();
    const target = (await readControlPlaneTable(tx, spec)).map((row) => canonicalJson(comparableRow(spec, row, "pg"))).sort();
    if (source.length !== target.length) {
      controlPlaneMismatches.push({ table: spec.table, detail: `${source.length} source row(s), ${target.length} imported` });
      continue;
    }
    const differ = source.filter((row, i) => row !== target[i]).length;
    if (differ > 0) controlPlaneMismatches.push({ table: spec.table, detail: `${differ} row(s) differ after conversion` });
  }

  const tables = await applicationTables(tx);
  const rows: Record<string, number> = {};
  const tableSha: Record<string, string> = {};
  for (const table of tables) {
    const found = await tx.query(`SELECT * FROM "${table}"`);
    rows[table] = found.length;
    tableSha[table] = canonicalHash(found.map((row) => canonicalJson(row)).sort());
  }

  return {
    version: 1,
    snapshot: {
      tenant_id: snapshot.meta.tenant_id,
      source: snapshot.meta.source,
      exported_at: snapshot.meta.exported_at,
      files: snapshot.meta.files,
    },
    accepted: plan.accepted,
    skipped: plan.skipped,
    findings: plan.findings,
    rows,
    table_sha256: tableSha,
    verification: {
      readings_checked: plan.readings.length,
      manifest_mismatches: manifestMismatches,
      field_totals_match: canonicalJson(expectedTotals) === canonicalJson(actualTotals),
      field_totals_sha256: canonicalHash(actualTotals),
      embeddings_checked: embeddingsChecked,
      embedding_mismatches: embeddingMismatches,
      control_plane_mismatches: controlPlaneMismatches,
    },
  };
}

export function describeAcceptance(code: BlockingCode): string {
  const spec = BLOCKING_CODES[code] as { accept?: string };
  return spec.accept ?? "cannot be accepted; fix the source and export again";
}
