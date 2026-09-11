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
// seeder writes. Seeding overwrites index/list.json with the pack's rows only:
// any other local reading keeps its objects but drops out of the list.

import { type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildLocalSeed, type LocalSeedObject } from "../test/fixtures/local-seed";
import { mapWithConcurrency } from "./lib/concurrency";
import { spawnWrangler } from "./lib/wrangler-cli";
import { isObjectNotFound } from "./corpus-lib/wrangler-r2";
import { LIST_INDEX_KEY } from "../src/modules/stores/layout";
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

/** Verification read-back; a transient wrangler/SQLite error is retried. */
export type ReadResult =
  | { kind: "found"; body: string }
  | { kind: "missing" }
  | { kind: "error"; output: string };

function readObject(key: string): Promise<ReadResult> {
  return new Promise((resolve) => {
    const child = spawnWrangler([
      "r2", "object", "get", `${BUCKET}/${key}`,
      "--local",
      "--pipe",
    ]);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => {
      resolve({ kind: "error", output: String(e) });
    });
    child.on("close", (code) => {
      if (code === 0) return resolve({ kind: "found", body: out });
      if (isObjectNotFound(err)) return resolve({ kind: "missing" });
      resolve({ kind: "error", output: err.trim() || `wrangler exited ${code}` });
    });
    if (child.stdin) child.stdin.end();
  });
}

export async function runSeed(
  deps: {
    put?: (object: LocalSeedObject) => Promise<PutResult>;
    read?: (key: string) => Promise<ReadResult>;
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
  // Write index/list.json last so it never lists a reading whose objects are
  // not in place yet.
  const listObject = plan.objects.find((o) => o.key === LIST_INDEX_KEY);
  const putObjects = plan.objects.filter((o) => o.key !== LIST_INDEX_KEY);

  const putWithRetry = async (object: LocalSeedObject): Promise<PutResult> => {
    let result = await put(object);
    for (let attempt = 1; attempt < PUT_ATTEMPTS && !result.ok; attempt++) {
      await sleep(RETRY_DELAY_MS * attempt);
      result = await put(object);
    }
    return result;
  };

  const readWithRetry = async (key: string): Promise<ReadResult> => {
    let result = await read(key);
    for (let attempt = 1; attempt < PUT_ATTEMPTS && result.kind === "error"; attempt++) {
      await sleep(RETRY_DELAY_MS * attempt);
      result = await read(key);
    }
    return result;
  };

  log(`Seeding ${plan.fixtures.length} fixture readings (${plan.objects.length} objects) into local R2 bucket "${BUCKET}"…`);
  const results = await mapWithConcurrency(putObjects, PUT_CONCURRENCY, putWithRetry);
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`put failed: ${failure.object.key}\n${failure.output}`);
    }
    return 1;
  }
  log(`Wrote ${putObjects.length} objects.`);

  const listResult = listObject === undefined ? null : await putWithRetry(listObject);
  if (listResult !== null && !listResult.ok) {
    console.error(`put failed: ${LIST_INDEX_KEY}\n${listResult.output}`);
    return 1;
  }

  const verifyRead = await readWithRetry(LIST_INDEX_KEY);
  if (verifyRead.kind !== "found") {
    console.error(
      `verification failed: could not read ${LIST_INDEX_KEY} back from local R2 (${verifyRead.kind})`,
    );
    return 1;
  }
  let list: ReturnType<typeof ListIndexSchema.parse>;
  try {
    list = ListIndexSchema.parse(JSON.parse(verifyRead.body));
  } catch {
    console.error(`verification failed: ${LIST_INDEX_KEY} did not parse after the write`);
    return 1;
  }
  const missing = plan.listIndex.items.filter(
    (item) => !list.items.some((row) => row.id === item.id),
  );
  if (missing.length > 0) {
    console.error(
      `verification failed: ${missing.length} fixture rows missing from ${LIST_INDEX_KEY}`,
    );
    return 1;
  }
  log(`Verified ${LIST_INDEX_KEY}: ${list.items.length} rows (${plan.listIndex.items.length} fixture rows).`);

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
