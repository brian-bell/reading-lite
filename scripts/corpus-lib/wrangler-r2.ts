import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListItem } from "./types";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface R2Deps {
  bucket: string;
  remote?: boolean;
  run?: Runner;
}

// Reads an object out of the R2 bucket via wrangler. Returns null when the
// object is absent (wrangler exits non-zero), which optional reads (manifest,
// extracted.md) tolerate.
export async function readObject(key: string, deps: R2Deps): Promise<string | null> {
  const run = deps.run ?? defaultRunner;
  const args = ["r2", "object", "get", `${deps.bucket}/${key}`, "--pipe"];
  if (deps.remote !== false) args.push("--remote");
  const { code, stdout, stderr } = await run("wrangler", args);
  if (code !== 0) {
    if (/not logged in/i.test(stderr)) {
      throw new Error("wrangler not authenticated — run `wrangler login` or set CLOUDFLARE_API_TOKEN");
    }
    return null;
  }
  return stdout;
}

export async function readListIndex(deps: R2Deps): Promise<ListItem[]> {
  const raw = await readObject("index/list.json", deps);
  if (raw === null) throw new Error(`could not read index/list.json from bucket ${deps.bucket}`);
  const parsed: unknown = JSON.parse(raw);
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("index/list.json has no items array");
  return items as ListItem[];
}

export async function readManifest(keyPrefix: string, deps: R2Deps): Promise<any | null> {
  const raw = await readObject(`${keyPrefix}/manifest.json`, deps);
  return raw === null ? null : JSON.parse(raw);
}

export async function readAttempt(keyPrefix: string, attemptId: string, deps: R2Deps): Promise<any | null> {
  const raw = await readObject(`${keyPrefix}/attempts/${attemptId}.json`, deps);
  return raw === null ? null : JSON.parse(raw);
}

export async function readExtracted(keyPrefix: string, deps: R2Deps): Promise<string | null> {
  return readObject(`${keyPrefix}/extracted.md`, deps);
}

// Deletes one object. wrangler exits 0 even for an absent key, so we classify
// from stderr: a "not found" message means it was already gone (idempotent).
export async function deleteObject(
  key: string,
  deps: R2Deps,
): Promise<"deleted" | "absent" | "error"> {
  const run = deps.run ?? defaultRunner;
  const args = ["r2", "object", "delete", `${deps.bucket}/${key}`];
  if (deps.remote !== false) args.push("--remote");
  const { code, stderr } = await run("wrangler", args);
  if (code === 0) return "deleted";
  if (/not found|does not exist|404|no such key/i.test(stderr)) return "absent";
  return "error";
}

// Rewrites index/list.json wholesale (a plain put, not a CAS write — run when
// nothing is being submitted so a concurrent queue write can't be lost).
export async function writeListIndex(items: ListItem[], deps: R2Deps): Promise<void> {
  const run = deps.run ?? defaultRunner;
  const dir = await mkdtemp(join(tmpdir(), "corpus-drop-"));
  const file = join(dir, "list.json");
  try {
    await writeFile(file, JSON.stringify({ version: 1, items }), "utf8");
    const args = [
      "r2", "object", "put", `${deps.bucket}/index/list.json`,
      "--file", file, "--content-type", "application/json",
    ];
    if (deps.remote !== false) args.push("--remote");
    const { code, stderr } = await run("wrangler", args);
    if (code !== 0) throw new Error(`put index/list.json failed: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const COMMON_RAW_EXTS = ["html", "txt", "json", "pdf", "bin", "md"];

// Every deletable key under one reading's id-scoped prefix. Reads the manifest
// live to recover attempt ids; raw.* exts are best-effort guesses (idempotent
// deletes absorb the misses).
//
// Attempt coverage is limited to the manifest's active_attempt + last_attempt.
// Each reprocess writes a new attempts/{at_*}.json, but the manifest records
// only those two ids, and the `wrangler r2 object` CLI (this tool's only R2
// access — corpus-drop intentionally needs just `wrangler login`, not S3/API
// creds) has no prefix list. So on a reading reprocessed >2x, earlier attempt
// JSONs can be orphaned. They're tiny, invisible to audits, and dangle nothing
// (manifest/by-id/list entry are all gone), so this is an accepted minor
// residue rather than a correctness problem; a full sweep would need S3
// ListObjectsV2, which we deliberately don't pull into this tool.
export async function keysForReading(
  id: string,
  keyPrefix: string,
  deps: R2Deps,
): Promise<string[]> {
  const keys = new Set<string>([
    `${keyPrefix}/manifest.json`,
    `${keyPrefix}/extracted.md`,
    `index/by-id/${id}`,
  ]);
  for (const ext of COMMON_RAW_EXTS) keys.add(`${keyPrefix}/raw.${ext}`);
  const m = await readManifest(keyPrefix, deps);
  if (m) {
    for (const k of ["active_attempt", "last_attempt"]) {
      const at = m?.[k]?.id;
      if (typeof at === "string") keys.add(`${keyPrefix}/attempts/${at}.json`);
    }
  }
  return [...keys];
}

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
