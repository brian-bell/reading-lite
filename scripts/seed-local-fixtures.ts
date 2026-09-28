#!/usr/bin/env tsx
// Seed the local fixture pack (issue #366) into the local PostgreSQL and R2
// that `npm run dev` reads, so frontend work can develop and check every
// accepted reading state without paid processing. See
// docs/operations.md#seeding-local-data and docs/design/connected/fixture-pack.md
// for the state each fixture represents.
//
// Reading state is rows (ADR 0005); R2 gets only the captured content the rows
// point at, written first. Objects go through the wrangler CLI's
// `r2 object put --local`, which targets the same on-disk store
// `.wrangler/state/v3/r2` that the dev server binds (verified against wrangler
// 4.130). Local dev leaves TENANT_DATA_PLANE unset, so the local founder reads
// global-rooted keys — exactly the keys this seeder writes.
//
// The rows go through the shared manifest-to-rows mapping, under the local
// founder's tenant id, with deterministic vectors so similarity has something
// to find, plus each fixture's attempt log. The tenant's existing reading rows
// are deleted first, so leftover local or retired-fixture readings drop out;
// their R2 objects stay. Rows are tenant-scoped even though local R2 keys are
// global-rooted.

import { type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildLocalSeed, type LocalSeedObject, type LocalSeedPlan } from "../test/fixtures/local-seed";
import { canonicalizeEmail } from "../src/control-plane/email";
import { sqlFromConnectionString, type SqlQuery } from "../src/modules/db/sql";
import { loadDotVars } from "./lib/dotvars";
import type { ProcessingAttempt } from "../src/schemas/manifest";
import { localSeedAttempts, localSeedRows } from "./pg-lib/local-seed-rows";
import { localDatabase, migrateLocalPostgres } from "./pg-lib/local-postgres";
import { upsertAttempt, writeReadingRows, type ReadingRows } from "./pg-lib/manifest-rows";
import { mapWithConcurrency } from "./lib/concurrency";
import { spawnWrangler } from "./lib/wrangler-cli";

// bucket_name of the READINGS_BUCKET binding in wrangler.toml (local dev).
const BUCKET = "reading-lite";
// Concurrent `wrangler r2 object put --local` processes each boot their own
// handle to the shared local store; too much overlap surfaces SQLite-lock
// flakes ("Unspecified error (0)"), so keep the pool small and retry the
// occasional loser.
const PUT_CONCURRENCY = 4;
const PUT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

interface PutResult {
  object: LocalSeedObject;
  ok: boolean;
  output: string;
}

function putObject(object: LocalSeedObject): Promise<PutResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawnWrangler([
      "r2", "object", "put", `${BUCKET}/${object.key}`,
      "--local",
      "--pipe",
      "--content-type", object.contentType,
    ]);
    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    child.on("error", (err) => {
      resolve({ object, ok: false, output: `${output}\n${String(err)}` });
    });
    child.on("close", (code) => {
      resolve({ object, ok: code === 0, output });
    });
    child.stdin?.on("error", () => {
      // EPIPE if the process exits before consuming stdin; the close handler
      // above still reports the real exit code.
    });
    child.stdin?.end(object.body, "utf8");
  });
}

/** What the seed read back from PostgreSQL after it committed. */
export interface PostgresSeedResult {
  tenantId: string;
  readings: number;
  attempts: number;
  embeddings: number;
}

// seed:local replaces the tenant's readings: deleting a reading cascades its
// attempts, URL claim and embedding. Relationship and tension refresh jobs
// reference only the tenant, so they are cleared explicitly, as purge does, or
// a stale job would outlive its reading. A reseed starts clean.
export async function replaceTenantReadings(
  tx: SqlQuery,
  tenantId: string,
  rows: ReadingRows[],
  attempts: readonly ProcessingAttempt[] = [],
): Promise<void> {
  await tx.query("DELETE FROM relationship_refresh_jobs WHERE tenant_id = $1", [tenantId]);
  await tx.query("DELETE FROM tension_refresh_jobs WHERE tenant_id = $1", [tenantId]);
  await tx.query("DELETE FROM readings WHERE tenant_id = $1", [tenantId]);
  for (const reading of rows) await writeReadingRows(tx, reading);
  for (const attempt of attempts) await upsertAttempt(tx, tenantId, attempt);
}

// Local rows belong to the founder that npm run dev bootstrapped into the
// same local database.
async function seedLocalPostgres(plan: LocalSeedPlan): Promise<PostgresSeedResult> {
  const envVars = { ...loadDotVars(".dev.vars"), ...process.env };
  const email = envVars.FOUNDER_EMAIL;
  if (!email) throw new Error("FOUNDER_EMAIL is not set in .dev.vars");

  const { url } = localDatabase(envVars);
  await migrateLocalPostgres(url);
  const sql = sqlFromConnectionString(url);
  try {
    const [founder] = await sql.query<{ id: string }>("SELECT id FROM users WHERE email_canonical = $1", [
      canonicalizeEmail(email),
    ]);
    if (!founder) throw new Error("no local founder for " + email + "; run npm run dev once first");
    const tenantId = founder.id;
    const rows = localSeedRows(plan, tenantId);
    await sql.transaction((tx) => replaceTenantReadings(tx, tenantId, rows, localSeedAttempts(plan)));
    const [counts] = await sql.query<{ readings: number; attempts: number; embeddings: number }>(
      `SELECT (SELECT count(*) FROM readings WHERE tenant_id = $1)::int AS readings,
              (SELECT count(*) FROM reading_attempts WHERE tenant_id = $1)::int AS attempts,
              (SELECT count(*) FROM reading_embeddings WHERE tenant_id = $1)::int AS embeddings`,
      [tenantId],
    );
    return { tenantId, ...counts! };
  } finally {
    await sql.end();
  }
}

export async function runSeed(
  deps: {
    seedPostgres?: (plan: LocalSeedPlan) => Promise<PostgresSeedResult>;
    put?: (object: LocalSeedObject) => Promise<PutResult>;
    log?: (line: string) => void;
    nowIso?: () => string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const put = deps.put ?? putObject;
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const plan = buildLocalSeed(nowIso());

  const putWithRetry = async (object: LocalSeedObject): Promise<PutResult> => {
    let result = await put(object);
    for (let attempt = 1; attempt < PUT_ATTEMPTS && !result.ok; attempt++) {
      await sleep(RETRY_DELAY_MS * attempt);
      result = await put(object);
    }
    return result;
  };

  // Content first: a row must never point at bytes that are not there yet.
  log(`Seeding ${plan.fixtures.length} fixture readings: ${plan.objects.length} content objects into local R2 bucket "${BUCKET}"…`);
  const results = await mapWithConcurrency(plan.objects, PUT_CONCURRENCY, putWithRetry);
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`put failed: ${failure.object.key}\n${failure.output}`);
    }
    return 1;
  }
  log(`Wrote ${plan.objects.length} objects.`);

  let seeded: PostgresSeedResult;
  try {
    seeded = await (deps.seedPostgres ?? seedLocalPostgres)(plan);
  } catch (error) {
    console.error(`PostgreSQL seed failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  // Similarity needs a vector per ready fixture; a mapping that stops producing
  // them would otherwise leave local similarity silently empty.
  const ready = plan.fixtures.filter((fixture) => fixture.manifest.status === "ready").length;
  if (seeded.embeddings !== ready) {
    console.error(
      `verification failed: PostgreSQL holds ${seeded.embeddings} vectors for tenant ${seeded.tenantId}; ` +
        `the pack has ${ready} ready readings`,
    );
    return 1;
  }
  log(`Seeded PostgreSQL: ${seeded.readings} readings, ${seeded.attempts} attempts, ${seeded.embeddings} vectors for tenant ${seeded.tenantId}.`);

  const pending = plan.fixtures.find((f) => f.name === "pending");
  log("");
  log("Fixture states (see docs/design/connected/fixture-pack.md):");
  for (const fixture of plan.fixtures) {
    log(`  ${fixture.name.padEnd(24)} ${fixture.id}  ${fixture.manifest.status}`);
  }
  log("");
  log("Next steps:");
  log("  • Start (or restart) `npm run dev` and sign in at http://localhost:8787");
  log("  • The pending fixture is stamped from this run's clock; re-run this command");
  log("    to refresh it once it passes the 15-minute pending TTL.");
  if (pending !== undefined) {
    log(`  • Pending reading id for deep links: ${pending.id}`);
  }
  return 0;
}

async function main(): Promise<void> {
  process.exit(await runSeed());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
