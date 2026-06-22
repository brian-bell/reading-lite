import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysForDroppedReading } from "./delete-plan";
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

// True when wrangler stderr signals the object genuinely does not exist (an R2
// NoSuchKey / "key does not exist" message), as opposed to a transient or
// permission error. Matches the textual not-found phrases only — deliberately
// NOT a bare "404" substring: by-url keys are SHA-256 hex strings that can
// themselves contain "404", and wrangler echoes the key path in error text, so
// a "404" match would misclassify a transient 5xx/403 on such a key as absent.
// The textual phrases contain spaces/non-hex letters, so they cannot collide
// with a hex key. Erring toward "not absent" is the safe direction: it makes an
// ambiguous failure surface as an error rather than a silent miss.
export function isObjectNotFound(stderr: string): boolean {
  return /not found|does not exist|no such key|nosuchkey/i.test(stderr);
}

type GetOutcome =
  | { kind: "present"; body: string }
  | { kind: "absent" }
  | { kind: "error"; detail: string };

// Runs a single `r2 object get` and classifies the result. An auth failure
// always throws (the whole tool is unusable). A "not found" stderr means the key
// is genuinely absent; any other non-zero exit is an untrusted read error that
// the caller must not mistake for absence.
async function getOutcome(key: string, deps: R2Deps): Promise<GetOutcome> {
  const run = deps.run ?? defaultRunner;
  const args = ["r2", "object", "get", `${deps.bucket}/${key}`, "--pipe"];
  if (deps.remote !== false) args.push("--remote");
  const { code, stdout, stderr } = await run("wrangler", args);
  if (code === 0) return { kind: "present", body: stdout };
  if (/not logged in/i.test(stderr)) {
    throw new Error("wrangler not authenticated — run `wrangler login` or set CLOUDFLARE_API_TOKEN");
  }
  if (isObjectNotFound(stderr)) return { kind: "absent" };
  return { kind: "error", detail: stderr.trim().split("\n").pop() ?? `exit ${code}` };
}

// Reads an object out of the R2 bucket via wrangler. Returns null when the
// object is absent OR unreadable — lenient by design so optional reads (manifest,
// extracted.md) tolerate a transient miss. For reads where "absent" and "could
// not read" must be distinguished (by-url ownership), use readObjectStrict.
export async function readObject(key: string, deps: R2Deps): Promise<string | null> {
  const r = await getOutcome(key, deps);
  return r.kind === "present" ? r.body : null;
}

// Like readObject, but returns null ONLY for a confirmed-absent key and throws
// on any untrusted read error. The by-url ownership read depends on this: a
// transient/permission failure must not be collapsed into "pointer absent",
// which would delete the reading and rewrite list.json while a pointer it owns
// lingers (see byUrlPointerKeyIfOwned).
export async function readObjectStrict(key: string, deps: R2Deps): Promise<string | null> {
  const r = await getOutcome(key, deps);
  if (r.kind === "present") return r.body;
  if (r.kind === "absent") return null;
  throw new Error(`could not read ${key}: ${r.detail}`);
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
  if (isObjectNotFound(stderr)) return "absent";
  return "error";
}

export async function deleteVector(
  index: string,
  id: string,
  deps: Pick<R2Deps, "run"> = {},
): Promise<"deleted" | "error"> {
  const run = deps.run ?? defaultRunner;
  const { code } = await run("wrangler", ["vectorize", "delete-vectors", index, "--ids", id]);
  return code === 0 ? "deleted" : "error";
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

// Every deletable key under one reading's id-scoped prefix, including its by-url
// ownership pointer ONLY when the dropped reading actually owns it (the pointer
// can legitimately belong to a surviving ready copy of the same URL — see
// `keysForDroppedReading`). Reads the manifest and pointer live; raw.* exts are
// best-effort guesses that idempotent deletes absorb. The `wrangler r2 object`
// CLI (this tool's only R2 access — corpus-drop intentionally needs just
// `wrangler login`, not S3/API creds) has no prefix list, so attempt coverage is
// limited to the manifest's two recorded attempt ids.
export async function keysForReading(
  id: string,
  keyPrefix: string,
  url: string,
  deps: R2Deps,
): Promise<string[]> {
  return keysForDroppedReading(id, keyPrefix, url, {
    // A corrupt manifest must not abort the drop: the static keys + pointer
    // logic can still proceed, so a parse failure degrades to null (matching the
    // DeletePlanDeps contract and the corpus-delete-orphans shim).
    readManifest: async (kp) => {
      try {
        return await readManifest(kp, deps);
      } catch {
        return null;
      }
    },
    // Strict: a confirmed-absent pointer returns null (not owned), but an
    // untrusted read error throws so we never strand a pointer this reading owns.
    readObject: (key) => readObjectStrict(key, deps),
  });
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
