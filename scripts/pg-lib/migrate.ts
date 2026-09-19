// Forward-only PostgreSQL migration runner (ADR 0005). Numbered SQL files in
// db/migrations/ (migrations/ stays D1's) are applied in order, one
// transaction per file, under a session advisory lock so two runners cannot
// interleave. Applied files are recorded in schema_migrations with a checksum;
// an applied file that later changes or disappears is drift, and the runner
// refuses rather than guessing. There is no down migration.
//
// Runs over a direct connection (operators, Actions, test setup), never
// through Hyperdrive: the advisory lock is session state.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const PG_MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "db", "migrations");

// Arbitrary constant; only this runner takes it.
const ADVISORY_LOCK_KEY = 347_001;
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationPlan {
  applied: MigrationFile[];
  pending: MigrationFile[];
}

// The slice of pg.Client the runner needs; tests and callers pass a real one.
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export class MigrationDriftError extends Error {}

export function readMigrations(dir: string = PG_MIGRATIONS_DIR): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".sql")) continue;
    const match = FILE_PATTERN.exec(entry);
    if (!match) throw new Error(`Migration file name must be NNNN_name.sql: ${entry}`);
    const sql = readFileSync(path.join(dir, entry), "utf8");
    files.push({
      version: match[1]!,
      name: match[2]!,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  const versions = new Set(files.map((file) => file.version));
  if (versions.size !== files.length) throw new Error(`Duplicate migration version in ${dir}`);
  return files;
}

// Read-only: safe for plan mode. Throws MigrationDriftError on drift.
export async function planMigrations(client: MigrationClient, files: MigrationFile[]): Promise<MigrationPlan> {
  const exists = await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  const recorded: { version: string; name: string; checksum: string }[] = exists.rows[0].present
    ? (await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version")).rows
    : [];
  const byVersion = new Map(files.map((file) => [file.version, file]));
  for (const row of recorded) {
    const file = byVersion.get(row.version);
    if (!file) throw new MigrationDriftError(`Applied migration ${row.version}_${row.name} has no file`);
    if (file.checksum !== row.checksum) {
      throw new MigrationDriftError(`Applied migration ${row.version}_${row.name} changed after it was applied`);
    }
  }
  const done = new Set(recorded.map((row) => row.version));
  const pending = files.filter((file) => !done.has(file.version));
  const lastApplied = recorded.at(-1)?.version;
  const outOfOrder = lastApplied === undefined ? undefined : pending.find((file) => file.version < lastApplied);
  if (outOfOrder) {
    throw new MigrationDriftError(`Migration ${outOfOrder.version}_${outOfOrder.name} is older than applied ${lastApplied}`);
  }
  return { applied: files.filter((file) => done.has(file.version)), pending };
}

// Applies every pending file and returns them. A failing file rolls back and
// stops the run; earlier files stay applied.
export async function migrate(client: MigrationClient, files: MigrationFile[]): Promise<MigrationFile[]> {
  await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { pending } = await planMigrations(client, files);
    for (const file of pending) {
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        // A dropped connection fails the rollback too; keep the real error.
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file.version}_${file.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return pending;
  } finally {
    // Session locks die with the connection, so a failed unlock must not mask
    // the migration's own error.
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => undefined);
  }
}
