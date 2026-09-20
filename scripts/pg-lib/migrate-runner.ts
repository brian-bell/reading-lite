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
 * Apply (or, without `execute`, merely report) the pending migrations.
 *
 * Returns 0 when the database is at or brought to the head of
 * `db/migrations/`, and 1 for drift or any connection/apply failure. A caller
 * that deploys must treat a non-zero return as fail-closed: nothing beyond
 * this point may run.
 */
export async function runPendingMigrations(run: MigrationRun): Promise<0 | 1> {
  const { io, mode } = run;
  const files = run.readMigrations();
  let client: MigrationConnection;
  try {
    client = await run.connect(run.databaseUrl);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    const plan = await planMigrations(client, files);
    io.stdout(`[${mode}] database from ${run.envName}: ${plan.applied.length} applied, ${plan.pending.length} pending`);
    for (const file of plan.pending) io.stdout(`[${mode}] pending ${label(file)}`);
    if (!run.execute) {
      if (plan.pending.length > 0) io.stdout(`[${mode}] re-run with --execute to apply.`);
      return 0;
    }
    for (const file of await migrate(client, files)) io.stdout(`[${mode}] applied ${label(file)}`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationDriftError) io.stderr(`Migration drift: ${error.message}`);
    else io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await client.end();
  }
}
