// Deletes "orphan-dup" pending readings identified by corpus-audit: pending
// entries whose URL already has a `ready` reading. They are cosmetic index
// cruft — the ready copy owns the canonical `index/by-url/{hash}` pointer, so
// removing the orphan touches nothing the ready copy depends on.
//
// Per orphan we delete, under its own id-scoped prefix only:
//   {prefix}/manifest.json        (durability: rebuildListIndex keys off this)
//   {prefix}/extracted.md         (best-effort)
//   {prefix}/raw.{ext}            (best-effort, common exts)
//   {prefix}/attempts/{id}.json   (ids read live from the manifest)
//   index/by-id/{id}              (so GET /api/readings/:id 404s instead of resolving)
//   index/by-url/{hash}           (ONLY if the stored pointer is owned by this
//                                  orphan — under eager URL ownership the slot
//                                  for this URL usually belongs to the surviving
//                                  ready copy, which we must not touch)
// Then we rewrite index/list.json once, dropping the orphan ids.
//
// Dry-run by default. Pass --execute to act. Read-only otherwise.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysForDroppedReading } from "./corpus-lib/delete-plan";
import { shouldRewriteIndex } from "./corpus-lib/drop";
import { isObjectNotFound } from "./corpus-lib/wrangler-r2";

interface RunResult { code: number; stdout: string; stderr: string }

interface Opts {
  indexPath: string;
  bucket: string;
  remote: boolean;
  execute: boolean;
  ids?: string[];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    indexPath: "index.json",
    bucket: process.env.READING_LITE_BUCKET ?? "reading-lite",
    remote: true,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--execute") opts.execute = true;
    else if (a === "--local") opts.remote = false;
    else if (a === "--bucket") opts.bucket = argv[++i];
    else if (a === "--index") opts.indexPath = argv[++i];
    else if (a === "--ids") opts.ids = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`corpus-delete-orphans — remove readings from the corpus, fully and consistently.

Usage:
  tsx scripts/corpus-delete-orphans.ts [--index index.json] [--bucket reading-lite] [--local] [--execute]
  tsx scripts/corpus-delete-orphans.ts --ids rd_AAA,rd_BBB [--execute]

Default mode removes the orphan-dup pending readings flagged by corpus-audit
(read from --index). With --ids, removes exactly those reading ids instead,
resolving each key_prefix from index/list.json (so duplicate failed copies of a
URL that the deduped audit omits are still caught).

Default is a DRY RUN: prints every object it would delete and the list.json diff.
Add --execute to perform the deletes and rewrite index/list.json.

For non-ready readings only. by-url pointers are eager URL ownership claims, so a
failed/pending reading may own its index/by-url/{hash} pointer — that pointer is
deleted only when it is actually owned by the dropped reading, never when it
belongs to a surviving ready copy of the same URL.

Run when nothing is being submitted: the list.json rewrite is a plain put, not a
CAS write, so a concurrent queue write could be lost.`);
}

const run = (cmd: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

function objPath(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

type GetOutcome =
  | { kind: "present"; body: string }
  | { kind: "absent" }
  | { kind: "error"; detail: string };

async function getOutcome(opts: Opts, key: string): Promise<GetOutcome> {
  const args = ["r2", "object", "get", objPath(opts.bucket, key), "--pipe"];
  if (opts.remote) args.push("--remote");
  const { code, stdout, stderr } = await run("npx", ["wrangler", ...args]);
  if (code === 0) return { kind: "present", body: stdout };
  if (/not logged in|not authenticated/i.test(stderr)) {
    throw new Error("wrangler not authenticated — run `wrangler login` or set CLOUDFLARE_API_TOKEN");
  }
  if (isObjectNotFound(stderr)) return { kind: "absent" };
  return { kind: "error", detail: stderr.trim().split("\n").pop() ?? `exit ${code}` };
}

// Lenient read: null for absent OR unreadable. Fine for the optional manifest
// read (a transient miss just degrades attempt-file coverage).
async function getObject(opts: Opts, key: string): Promise<string | null> {
  const r = await getOutcome(opts, key);
  return r.kind === "present" ? r.body : null;
}

// Strict read: null only for a confirmed-absent key; throws on an untrusted read
// error. Used for the by-url ownership read so an unreadable pointer aborts the
// drop instead of being mistaken for "not owned".
async function getObjectStrict(opts: Opts, key: string): Promise<string | null> {
  const r = await getOutcome(opts, key);
  if (r.kind === "present") return r.body;
  if (r.kind === "absent") return null;
  throw new Error(`could not read ${key}: ${r.detail}`);
}

async function deleteObject(opts: Opts, key: string): Promise<"deleted" | "absent" | "error"> {
  const args = ["r2", "object", "delete", objPath(opts.bucket, key)];
  if (opts.remote) args.push("--remote");
  const { code, stderr } = await run("npx", ["wrangler", ...args]);
  if (code === 0) return "deleted";
  if (isObjectNotFound(stderr)) return "absent";
  console.error(`  ! delete error for ${key}: ${stderr.trim().split("\n").pop()}`);
  return "error";
}

async function putListIndex(opts: Opts, json: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "corpus-orphans-"));
  const file = join(dir, "list.json");
  try {
    await writeFile(file, json, "utf8");
    const args = [
      "r2", "object", "put", objPath(opts.bucket, "index/list.json"),
      "--file", file, "--content-type", "application/json",
    ];
    if (opts.remote) args.push("--remote");
    const { code, stderr } = await run("npx", ["wrangler", ...args]);
    if (code !== 0) throw new Error(`put index/list.json failed: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Derive the deletable keys under one orphan's prefix via the shared
// ownership-aware plan. The by-url pointer is included only when this orphan
// actually owns it — under eager URL ownership the pointer for this URL may
// belong to the surviving ready copy, which we must not delete.
async function keysForOrphan(
  opts: Opts,
  id: string,
  prefix: string,
  url: string,
): Promise<string[]> {
  return keysForDroppedReading(id, prefix, url, {
    readManifest: async (kp) => {
      const raw = await getObject(opts, `${kp}/manifest.json`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    // Strict: an unreadable pointer aborts rather than stranding an owned slot.
    readObject: (key) => getObjectStrict(opts, key),
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Read list.json up front: it's the authoritative source of key_prefix for
  // --ids mode, and the diff is shown even in a dry run.
  const listRaw = await getObject(opts, "index/list.json");
  if (listRaw === null) {
    console.error("could not read index/list.json — aborting.");
    process.exit(1);
  }
  const listObj = JSON.parse(listRaw);
  const listItems: any[] = Array.isArray(listObj.items) ? listObj.items : [];
  const byId = new Map<string, any>(listItems.map((i) => [i.id, i]));

  let targets: Array<{ id: string; prefix: string; url: string }>;
  let label: string;

  if (opts.ids && opts.ids.length > 0) {
    label = "readings (--ids)";
    targets = opts.ids.map((id) => {
      const it = byId.get(id);
      if (!it) {
        console.error(`refusing to proceed: id ${id} not found in index/list.json`);
        process.exit(1);
      }
      if (it.status === "ready") {
        console.error(`refusing to proceed: ${id} is ready — deleting it would dangle its by-url pointer`);
        process.exit(1);
      }
      return { id, prefix: it.key_prefix, url: it.url };
    });
  } else {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(opts.indexPath, "utf8"));
    } catch (e) {
      console.error(`could not read audit index at ${opts.indexPath}: ${(e as Error).message}`);
      console.error("run `npm run ops -- corpus audit --execute` first, or pass --index <path>.");
      process.exit(1);
    }
    label = "orphan-dup readings";
    targets = (parsed.rows ?? [])
      .filter((r: any) => r.category === "pending" && r.class === "orphan-dup")
      .map((r: any) => ({ id: r.reading_id, prefix: r.key_prefix, url: r.url }));
  }

  if (targets.length === 0) {
    console.log("nothing to delete — empty target set.");
    return;
  }

  // Safety: every prefix must be id-scoped under readings/. Never touch a
  // prefix that doesn't carry its own reading id.
  for (const o of targets) {
    if (
      !o.id || !o.prefix || typeof o.url !== "string" ||
      !o.prefix.startsWith("readings/") || !o.prefix.endsWith(o.id)
    ) {
      console.error(`refusing to proceed: target failed prefix/id guard: ${JSON.stringify(o)}`);
      process.exit(1);
    }
  }

  const targetIds = new Set(targets.map((o) => o.id));

  console.log(`Bucket: ${opts.bucket}${opts.remote ? "" : " (local)"}`);
  console.log(`${label} to remove: ${targets.length}`);
  console.log(`Mode: ${opts.execute ? "EXECUTE" : "DRY RUN"}\n`);

  const beforeCount = listItems.length;
  const keptItems = listItems.filter((i) => !targetIds.has(i.id));
  const removedFromList = beforeCount - keptItems.length;

  let deleted = 0;
  let absent = 0;
  let errored = 0;

  for (const o of targets) {
    const keys = await keysForOrphan(opts, o.id, o.prefix, o.url);
    console.log(`• ${o.id}  ${o.url}`);
    for (const key of keys) {
      if (!opts.execute) {
        console.log(`    would delete  ${key}`);
        continue;
      }
      const res = await deleteObject(opts, key);
      if (res === "deleted") { deleted++; console.log(`    deleted   ${key}`); }
      else if (res === "absent") { absent++; }
      else errored++;
    }
  }

  console.log(
    `\nindex/list.json: ${beforeCount} items → ${keptItems.length} ` +
    `(removing ${removedFromList} entr${removedFromList === 1 ? "y" : "ies"})`,
  );
  if (removedFromList !== targets.length) {
    console.warn(
      `  note: ${targets.length} targeted but ${removedFromList} matched in list.json ` +
      `(some may already be gone).`,
    );
  }

  if (!opts.execute) {
    console.log("\nDRY RUN — nothing changed. Re-run with --execute to apply.");
    return;
  }

  // Don't rewrite the index if any object delete failed: removing an orphan from
  // index/list.json while its objects/pointers (including a by-url ownership
  // pointer it owns) linger would hide a half-deleted reading from future audits.
  // Mirror corpus-drop — leave the list intact so the cleanup stays visible and
  // re-runnable.
  if (!shouldRewriteIndex(errored)) {
    console.error(
      `\n${errored} object delete(s) failed — leaving index/list.json unchanged ` +
      `so the partially-deleted reading(s) stay visible. Re-run to retry.`,
    );
    console.error(`objects deleted: ${deleted}, absent (skipped): ${absent}, errors: ${errored}`);
    process.exitCode = 1;
    return;
  }

  await putListIndex(opts, JSON.stringify({ version: 1, items: keptItems }));
  console.log("\nindex/list.json rewritten.");
  console.log(`Done. objects deleted: ${deleted}, absent (skipped): ${absent}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
