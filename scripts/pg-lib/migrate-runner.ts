// The shared body of a migration run: plan, report, and (on --execute) apply.
//
// Two commands need it. `ops db migrate` is the operator's direct entry point;
// `ops deploy worker` folds the same run in ahead of the upload so a release
// whose code expects a new column cannot reach an environment whose database
// lacks it (reading-lite-gh347.4.4). Sharing the body keeps drift handling,
// the applied/pending reporting, and the connection teardown under one owner.

import {
  MigrationDriftError,
  migrate,
  planMigrations,
  type MigrationClient,
  type MigrationFile,
} from "./migrate";
import type { CommandIo } from "../ops-lib/contract";

export type MigrationConnection = MigrationClient & { end(): Promise<void> };

/** A DIRECT pg session for a migration run; the commands' default `connect`. */
export async function connectMigrationClient(databaseUrl: string): Promise<MigrationConnection> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

export interface MigrationRun {
  io: CommandIo;
  // Label for the reported lines: "PLAN", "MIGRATE", "DEPLOY".
  mode: string;
  // Named for the report so the operator can see which database was reached.
  envName: string;
  databaseUrl: string;
  execute: boolean;
  readMigrations: () => MigrationFile[];
  connect: (databaseUrl: string) => Promise<MigrationConnection>;
}

const label = (file: MigrationFile) => `${file.version}_${file.name}`;

/**
 * Why a run did not reach the head of db/migrations/.
 *
 * Callers need the distinction. A plan may tolerate `unreachable` — the
 * database was not consulted, which is a gap in the plan, not evidence against
 * it. `drift` and `failed` are the opposite: the migration history was read
 * and is not something the operator may act on, so they survive even a plan.
 */
export type MigrationFailure = "unreachable" | "drift" | "failed";

export type MigrationOutcome = { ok: true } | { ok: false; reason: MigrationFailure };

/**
 * Apply (or, without `execute`, merely report) the pending migrations.
 *
 * Reports success, or why not. A caller that deploys must treat any failure
 * as fail-closed: nothing beyond this point may run.
 */
export async function runPendingMigrations(run: MigrationRun): Promise<MigrationOutcome> {
  const { io, mode } = run;
  const files = run.readMigrations();
  let client: MigrationConnection;
  try {
    client = await run.connect(run.databaseUrl);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return { ok: false, reason: "unreachable" };
  }
  try {
    const plan = await planMigrations(client, files);
    io.stdout(`[${mode}] database from ${run.envName}: ${plan.applied.length} applied, ${plan.pending.length} pending`);
    for (const file of plan.pending) io.stdout(`[${mode}] pending ${label(file)}`);
    if (!run.execute) {
      if (plan.pending.length > 0) io.stdout(`[${mode}] re-run with --execute to apply.`);
      return { ok: true };
    }
    for (const file of await migrate(client, files)) io.stdout(`[${mode}] applied ${label(file)}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof MigrationDriftError) {
      io.stderr(`Migration drift: ${error.message}`);
      return { ok: false, reason: "drift" };
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return { ok: false, reason: "failed" };
  } finally {
    await client.end();
  }
}
