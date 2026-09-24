import { spawnCommand } from "../lib/wrangler-cli";

// Reads and deletes single R2 objects through the wrangler CLI, for the
// operator commands that still touch captured content (corpus audit reads
// extracted.md; corpus drop and sweep delete a reading's content keys). The
// reading inventory itself lives in PostgreSQL, so this module knows nothing
// about manifests, pointers or index/list.json.
//
// Relative-key spelling only. The tenant root is NOT baked in here: every key
// this module handles stays relative (plan output, delete plans, returned key
// lists), and the root carried on R2Deps.keyRoot is applied at the single
// point where a key becomes a bucket path (bucketPath below). Commands obtain
// the root from a validated operator tenant selector (corpus-lib/tenant.ts).

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
// NOT a bare "404" substring: content keys embed reading ids and hashes that
// can themselves contain "404", and wrangler echoes the key path in error
// text, so a "404" match would misclassify a transient 5xx/403 on such a key
// as absent. The textual phrases contain spaces/non-hex letters, so they
// cannot collide with a hex key. Erring toward "not absent" is the safe
// direction: it makes an ambiguous failure surface as an error rather than a
// silent miss.
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
// object is absent OR unreadable — lenient by design so an optional content
// read (extracted.md for the audit's paywall check) tolerates a transient miss.
// Nothing this module serves decides ownership, so no strict variant remains.
export async function readObject(key: string, deps: R2Deps): Promise<string | null> {
  const r = await getOutcome(key, deps);
  return r.kind === "present" ? r.body : null;
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

// Collect each stream as raw bytes and decode once at close. Decoding per
// "data" chunk splits a multibyte UTF-8 character that straddles a chunk
// boundary into U+FFFD replacement characters — which is how rebuild-list once
// wrote em dashes in three production titles as "��" (2026-08-30).
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
