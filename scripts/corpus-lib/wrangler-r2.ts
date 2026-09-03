import { spawnCommand } from "../lib/wrangler-cli";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysForDroppedReading } from "./delete-plan";
import type { ListItem } from "./types";
import { r2KeyLayout } from "../../src/modules/stores/layout";

// Relative-key spelling only. The tenant root is NOT baked in here: every key
// this module handles stays relative (plan output, delete plans, returned key
// lists), and the root carried on R2Deps.keyRoot is applied at the single
// point where a key becomes a bucket path (bucketPath below). Commands obtain
// the root from a validated operator tenant selector (corpus-lib/tenant.ts).
const layout = r2KeyLayout();

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface R2Deps {
  bucket: string;
  /**
   * The tenant key root every bucket path is prefixed with: "" for the
   * pre-tenant global layout, `u/{tenantId}/` for one tenant's namespace.
   * Required — callers must resolve it from an explicit tenant selector
   * (resolveOperatorTenant) rather than defaulting to the global root.
   */
  keyRoot: string;
  remote?: boolean;
  run?: Runner;
}

// The single point where a relative key becomes an absolute bucket path.
function bucketPath(key: string, deps: R2Deps): string {
  return `${deps.bucket}/${deps.keyRoot}${key}`;
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
  const args = ["r2", "object", "get", bucketPath(key, deps), "--pipe"];
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
  const raw = await readObject(layout.listIndexKey(), deps);
  if (raw === null) throw new Error(`could not read ${layout.listIndexKey()} from bucket ${deps.bucket}`);
  const parsed: unknown = JSON.parse(raw);
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error(`${layout.listIndexKey()} has no items array`);
  return items as ListItem[];
}

export async function readManifest(keyPrefix: string, deps: R2Deps): Promise<any | null> {
  const raw = await readObject(layout.manifestKey(keyPrefix), deps);
  return raw === null ? null : JSON.parse(raw);
}

export async function readAttempt(keyPrefix: string, attemptId: string, deps: R2Deps): Promise<any | null> {
  const raw = await readObject(layout.attemptKey(keyPrefix, attemptId), deps);
  return raw === null ? null : JSON.parse(raw);
}

export async function readExtracted(keyPrefix: string, deps: R2Deps): Promise<string | null> {
  return readObject(layout.extractedKey(keyPrefix), deps);
}

// Deletes one object. wrangler exits 0 even for an absent key, so we classify
// from stderr: a "not found" message means it was already gone (idempotent).
export async function deleteObject(
  key: string,
  deps: R2Deps,
): Promise<"deleted" | "absent" | "error"> {
  const run = deps.run ?? defaultRunner;
  const args = ["r2", "object", "delete", bucketPath(key, deps)];
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

// Queries the index using a vector that is already stored, by id. This is what
// makes the similarity backfill free: no embedding call, no OpenAI spend, and no
// risk of a freshly-computed embedding drifting from the vector actually indexed.
//
// Returns null ONLY for the confirmed missing-vector signal — a `ready` row
// whose vector was never written, or was removed. That is a real state in the
// corpus (the index holds fewer vectors than there are ready readings), and the
// caller must report it rather than silently record an empty neighbourhood,
// which would be indistinguishable from a genuinely isolated reading.
//
// Every other failure throws. Collapsing an error into null would invent a
// corpus gap, which is the same mistake in the opposite direction and just as
// misleading. This mirrors readObjectStrict / isObjectNotFound in this module:
// erring toward "not absent" is the safe direction.
// The exact phrase wrangler emits for an id that has no vector in the index.
const VECTOR_NOT_FOUND = /could not find any relevant vectors/i;

// Neighbour identity plus the metadata refresh-neighbours needs: created_at
// for the age test, and title/tldr/tags so later judgement slices can build a
// prompt without extra R2 reads. Optional because older vectors may omit them.
export interface VectorQueryMatch {
  id: string;
  score: number;
  title?: string;
  tldr?: string;
  tags?: string[];
  created_at?: string;
}

export async function queryByVectorId(
  index: string,
  id: string,
  topK: number,
  deps: Pick<R2Deps, "run"> & { namespace?: string; metadata?: boolean } = {},
): Promise<VectorQueryMatch[] | null> {
  const run = deps.run ?? defaultRunner;
  const { code, stdout, stderr } = await run("wrangler", [
    "vectorize", "query", index,
    "--vector-id", id,
    "--top-k", String(topK),
    // The measurement pass wants title/tldr/tags/created_at for the report; a
    // reverse-neighbour scoping query wants ids and scores only, and asking for
    // a hundred readings' metadata to discard it is pure transfer.
    "--return-metadata", deps.metadata === false ? "none" : "all",
    // Tenant-namespaced queries (s1k.4.3): a namespaced query can only match
    // vectors in that namespace, mirroring the worker's similarityStoreFor.
    ...(deps.namespace === undefined ? [] : ["--namespace", deps.namespace]),
  ]);
  // A missing vector is NOT an error exit. Verified against wrangler 4.101:
  // an unknown vector id exits 0, prints no JSON, and writes
  // "Could not find any relevant vectors" to stderr. So a non-zero exit is
  // always a real failure -- there is no not-found phrase to match for here,
  // and matching one could only ever misclassify a genuine error as a missing
  // vector (wrangler dumps usage text full of quotable phrases on a bad flag).
  if (code !== 0) {
    throw new Error(`vectorize query failed for ${id}: ${stderr.trim().split("\n").pop() ?? code}`);
  }
  if (VECTOR_NOT_FOUND.test(stderr)) return null;
  const start = stdout.indexOf("{");
  // Zero exit, no JSON, and not the known warning: something changed in
  // wrangler's output. Fail loudly rather than return null, which would report
  // a corpus gap that does not exist -- the one thing this function must keep
  // distinct from a genuine missing vector.
  if (start < 0) {
    throw new Error(`unexpected vectorize query output for ${id}: ${stdout.trim().slice(0, 120)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`could not parse vectorize query output for ${id}`);
  }
  const matches = (parsed as { matches?: unknown }).matches;
  // Same rule as the two cases above: only the known not-found phrase means
  // "no vector". JSON with no matches array is an output shape we do not
  // recognise, and reporting it as absence would let a malformed response
  // shrink an incremental refresh scope instead of escalating it.
  if (!Array.isArray(matches)) {
    throw new Error(`unexpected vectorize query output for ${id}: no matches array`);
  }
  const parsedMatches = matches.map((match: unknown) => parseVectorQueryMatch(match));
  // A dropped entry costs the measurement pass one neighbour, but it costs a
  // reverse-neighbour scoping query its page count — a truncated hundred would
  // arrive as ninety-nine and read as a complete set, narrowing the scope on a
  // response we did not understand. So the metadata-less caller gets an error
  // where the measuring one gets tolerance.
  if (deps.metadata === false && parsedMatches.some((match) => match === null)) {
    throw new Error(`unexpected vectorize match entry for ${id}`);
  }
  return parsedMatches.filter((m): m is VectorQueryMatch => m !== null);
}

// Exported so the direct (S3/REST) tier-1 adapter maps matches through exactly
// this function: the two adapters must produce identical neighbour objects, or
// the same corpus yields two different refresh-report.json files.
export function parseVectorQueryMatch(raw: unknown): VectorQueryMatch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as { id?: unknown; score?: unknown; metadata?: unknown };
  if (typeof rec.id !== "string" || typeof rec.score !== "number") return null;
  const out: VectorQueryMatch = { id: rec.id, score: rec.score };
  const md =
    typeof rec.metadata === "object" && rec.metadata !== null && !Array.isArray(rec.metadata)
      ? (rec.metadata as Record<string, unknown>)
      : undefined;
  if (md === undefined) return out;
  if (typeof md.title === "string") out.title = md.title;
  if (typeof md.tldr === "string") out.tldr = md.tldr;
  if (typeof md.created_at === "string") out.created_at = md.created_at;
  if (Array.isArray(md.tags)) {
    out.tags = md.tags.filter((t): t is string => typeof t === "string");
  }
  return out;
}

// Whether the index actually holds a vector for this reading.
//
// Status cannot answer this. Reprocessing a ready reading leaves a `pending`
// row whose vector is still indexed (activateAttempt never touches Vectorize),
// and a failed re-import over a previously-ready reading can leave a `failed`
// row whose old vector survived the null-SimilarityStore failure path. Every
// attempt to infer ownership from status has been wrong in some direction, so
// this asks the index instead.
//
// Same three-outcome discipline as queryByVectorId: a confirmed not-found
// exits ZERO with a warning, so a non-zero exit is a real failure and throws
// rather than being read as absence.
const VECTOR_IDS_NOT_FOUND = /does not contain vectors corresponding/i;

export async function vectorExists(
  index: string,
  id: string,
  deps: Pick<R2Deps, "run"> & { namespace?: string } = {},
): Promise<boolean> {
  const run = deps.run ?? defaultRunner;
  const { code, stdout, stderr } = await run("wrangler", [
    "vectorize", "get-vectors", index, "--ids", id,
  ]);
  if (code !== 0) {
    throw new Error(`vectorize get-vectors failed for ${id}: ${stderr.trim().split("\n").pop() ?? code}`);
  }
  if (VECTOR_IDS_NOT_FOUND.test(stderr)) return false;
  const start = stdout.indexOf("[");
  if (start < 0) {
    throw new Error(`unexpected vectorize get-vectors output for ${id}: ${stdout.trim().slice(0, 120)}`);
  }
  try {
    const vectors = JSON.parse(stdout.slice(start)) as Array<{ namespace?: string }>;
    // A vector id is unique per index, but its NAMESPACE decides which tenant
    // can see it (s1k.4.3): a legacy un-namespaced vector does not exist for a
    // tenant selection, and vice versa — treating it as present would make a
    // backfill skip the re-upsert that moves it into the right namespace.
    return vectors.some((v) => v.namespace === deps.namespace);
  } catch {
    throw new Error(`could not parse vectorize get-vectors output for ${id}`);
  }
}

// Rewrites index/list.json wholesale (a plain put, not a CAS write — run when
// nothing is being submitted so a concurrent queue write can't be lost).
export async function writeListIndex(items: ListItem[], deps: R2Deps): Promise<void> {
  await writeJsonObject(layout.listIndexKey(), { version: 1, items }, deps);
}

// One unconditional JSON put. The wrangler CLI writes from a file, so every
// caller would otherwise repeat the same temp-file dance. `r2 object put` has
// no If-Match, which is why this stays a sole-writer path and the direct
// adapter owns the conditional writes.
export async function writeJsonObject(key: string, body: unknown, deps: R2Deps): Promise<void> {
  const run = deps.run ?? defaultRunner;
  const dir = await mkdtemp(join(tmpdir(), "corpus-put-"));
  // The basename is cosmetic — wrangler names the object from the bucket path —
  // but deriving it from the key keeps a leaked temp file traceable.
  const file = join(dir, key.split("/").pop() || "object.json");
  try {
    await writeFile(file, JSON.stringify(body), "utf8");
    const args = [
      "r2", "object", "put", bucketPath(key, deps),
      "--file", file, "--content-type", "application/json",
    ];
    if (deps.remote !== false) args.push("--remote");
    const { code, stderr } = await run("wrangler", args);
    if (code !== 0) throw new Error(`put ${key} failed: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The nightly-refresh run marker. Read strictly so the two outcomes stay
// distinguishable at this layer: null is a confirmed-absent marker, and a
// failed read throws. Both end in a full sweep — the command catches the throw
// and says so on stderr — but only because the command decided that, and it can
// only report the difference if this function keeps it.
export async function readRefreshState(deps: R2Deps): Promise<unknown | null> {
  const raw = await readObjectStrict(layout.refreshStateKey(), deps);
  return raw === null ? null : JSON.parse(raw);
}

export async function writeRefreshState(state: unknown, deps: R2Deps): Promise<void> {
  await writeJsonObject(layout.refreshStateKey(), state, deps);
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

// Collect each stream as raw bytes and decode once at close. Decoding per
// "data" chunk splits a multibyte UTF-8 character that straddles a chunk
// boundary into U+FFFD replacement characters — which is how rebuild-list once
// wrote em dashes in three production titles as "\uFFFD\uFFFD" (2026-08-30).
export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawnCommand(cmd, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdout.push(d));
    child.stderr?.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
