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
// seeder writes. The dev server must be stopped first: the CLI has no
// conditional put, so the list-index merge would have no concurrency guard
// against a live worker's own index writes. The command refuses to run while
// anything is listening on the dev port.

import net from "node:net";
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
// The default `wrangler dev` port (no [dev] port override in wrangler.toml).
const DEV_PORT = 8787;
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

/**
 * A read that distinguishes a confirmed missing object from an operational
 * failure: treating a transient wrangler/SQLite error as absence would let the
 * seeder overwrite an index it could not read, losing exactly the pre-existing
 * rows the merge exists to preserve.
 */
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

/** True when something is already listening on the dev port. */
function devServerListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1_000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

export async function runSeed(
  deps: {
    put?: (object: LocalSeedObject) => Promise<PutResult>;
    read?: (key: string) => Promise<ReadResult>;
    log?: (line: string) => void;
    nowIso?: () => string;
    sleep?: (ms: number) => Promise<void>;
    listening?: (port: number) => Promise<boolean>;
  } = {},
): Promise<number> {
  const put = deps.put ?? putObject;
  const read = deps.read ?? readObject;
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const listening = deps.listening ?? devServerListening;

  // The list-index merge below has no compare-and-set (the CLI offers no
  // conditional put), so a live dev server's own index writes could be lost.
  // Refuse to seed against a running dev server instead.
  if (await listening(DEV_PORT)) {
    console.error(
      `refusing to seed: something is listening on 127.0.0.1:${DEV_PORT}. ` +
        "Stop `npm run dev` before seeding — the list-index merge is not " +
        "concurrency-guarded against a live dev server.",
    );
    return 1;
  }

  const plan = buildLocalSeed(nowIso());
  const listKey = plan.objects.find((o) => o.key === LIST_INDEX_KEY);
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

  // Read and validate the existing index BEFORE writing anything, so every
  // failure mode below is side-effect-free. Merge, don't replace: preserve
  // rows the developer seeded by hand or by other tooling, replacing only
  // this pack's own rows in place. An index that exists but cannot be read
  // or parsed fails closed — its rows keep their manifests and pointers
  // either way, and the store never rebuilds a present-but-unparseable
  // index.
  const existingRead = listKey === undefined
    ? ({ kind: "missing" } as const)
    : await readWithRetry(LIST_INDEX_KEY);
  let mergedItems = [...plan.listIndex.items];
  if (existingRead.kind === "error") {
    console.error(
      `refusing to seed: could not read ${LIST_INDEX_KEY} from local R2 ` +
        `(after ${PUT_ATTEMPTS} attempts): ${existingRead.output}`,
    );
    return 1;
  }
  if (existingRead.kind === "found") {
    let existing: ReturnType<typeof ListIndexSchema.safeParse> | null = null;
    try {
      existing = ListIndexSchema.safeParse(JSON.parse(existingRead.body));
    } catch {
      existing = null;
    }
    if (existing === null || !existing.success) {
      console.error(
        `refusing to seed: the existing ${LIST_INDEX_KEY} does not parse, and ` +
          "overwriting it would hide every non-fixture reading. Repair or remove " +
          "it first (a pristine reset is `rm -rf .wrangler/state/v3/r2`, then " +
          "re-run this command).",
      );
      return 1;
    }
    const fixtureIds = new Set(plan.listIndex.items.map((i) => i.id));
    const preserved = existing.data.items.filter((i) => !fixtureIds.has(i.id));
    mergedItems = [...preserved, ...plan.listIndex.items];
    if (preserved.length > 0) {
      log(`Preserved ${preserved.length} pre-existing list rows.`);
    }
  }

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

  const mergedListResult =
    listKey === undefined ? null : await putWithRetry({ ...listKey, body: JSON.stringify({ version: 1, items: mergedItems }) });
  if (mergedListResult !== null && !mergedListResult.ok) {
    console.error(`put failed: ${LIST_INDEX_KEY}\n${mergedListResult.output}`);
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
  log("  • Start `npm run dev` and sign in at http://localhost:8787");
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
