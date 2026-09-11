#!/usr/bin/env tsx
// Seed the local fixture pack (issue #366) into the local R2 bucket that
// `npm run dev` reads, so Phase 3 slices can develop and check every accepted
// reading state without paid processing. See docs/operations.md#seeding-local-r2
// and docs/design/connected/fixture-pack.md for the state each fixture
// represents.
//
// Objects are written with the wrangler CLI's `r2 object put --local`, which
// targets the same on-disk store `.wrangler/state/v3/r2` that the dev server
// binds (verified against wrangler 4.130; the older "different local store"
// caveat no longer holds). Local dev leaves TENANT_DATA_PLANE unset, so the
// local founder account reads global-rooted keys — exactly the keys this
// seeder writes. A running dev server sees new objects without a restart,
// but restarting after a large seed is the reliable habit.

import { type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildLocalSeed, type LocalSeedObject } from "../test/fixtures/local-seed";
import { mapWithConcurrency } from "./lib/concurrency";
import { spawnWrangler } from "./lib/wrangler-cli";
import { ListIndexSchema } from "../src/schemas/api";

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

function readObject(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnWrangler([
      "r2", "object", "get", `${BUCKET}/${key}`,
      "--local",
      "--pipe",
    ]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", () => {});
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
    if (child.stdin) child.stdin.end();
  });
}

export async function runSeed(
  deps: {
    put?: (object: LocalSeedObject) => Promise<PutResult>;
    read?: (key: string) => Promise<string | null>;
    log?: (line: string) => void;
    nowIso?: () => string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const put = deps.put ?? putObject;
  const read = deps.read ?? readObject;
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const plan = buildLocalSeed(nowIso());
  log(`Seeding ${plan.fixtures.length} fixture readings (${plan.objects.length} objects) into local R2 bucket "${BUCKET}"…`);

  const putWithRetry = async (object: LocalSeedObject): Promise<PutResult> => {
    let result = await put(object);
    for (let attempt = 1; attempt < PUT_ATTEMPTS && !result.ok; attempt++) {
      await sleep(RETRY_DELAY_MS * attempt);
      result = await put(object);
    }
    return result;
  };

  const results = await mapWithConcurrency(plan.objects, PUT_CONCURRENCY, putWithRetry);
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`put failed: ${failure.object.key}\n${failure.output}`);
    }
    return 1;
  }
  log(`Wrote ${plan.objects.length} objects.`);

  const listRaw = await read("index/list.json");
  if (listRaw === null) {
    console.error("verification failed: could not read index/list.json back from local R2");
    return 1;
  }
  const list = ListIndexSchema.parse(JSON.parse(listRaw));
  const rows = list.items.length;
  log(`Verified index/list.json: ${rows} rows.`);

  const pending = plan.fixtures.find((f) => f.name === "pending");
  log("");
  log("Fixture states (see docs/design/connected/fixture-pack.md):");
  for (const fixture of plan.fixtures) {
    log(`  ${fixture.name.padEnd(24)} ${fixture.id}  ${fixture.manifest.status}`);
  }
  log("");
  log("Next steps:");
  log("  • Restart `npm run dev` if it is already running, then sign in at http://localhost:8787");
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
