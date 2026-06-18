import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface FetchIndexDeps {
  bucket: string;
  // "index/list.json" by default; the worker's LIST_INDEX_KEY.
  key?: string;
  // --remote reads the real R2 bucket rather than the local miniflare cache.
  remote?: boolean;
  run?: Runner;
}

const DEFAULT_KEY = "index/list.json";

// Reads the corpus index straight out of R2 via wrangler. Returns the raw
// JSON text; parsing is the caller's job (parseListIndex). Throws with
// wrangler's stderr on failure so an unauthenticated session surfaces clearly.
export async function fetchListIndex(deps: FetchIndexDeps): Promise<string> {
  const run = deps.run ?? defaultRunner;
  const key = deps.key ?? DEFAULT_KEY;
  const args = ["r2", "object", "get", `${deps.bucket}/${key}`, "--pipe"];
  if (deps.remote !== false) args.push("--remote");

  const { code, stdout, stderr } = await run("wrangler", args);
  if (code !== 0) {
    const hint = /not logged in/i.test(stderr)
      ? " (run `wrangler login` or set CLOUDFLARE_API_TOKEN)"
      : "";
    throw new Error(
      `wrangler r2 object get ${deps.bucket}/${key} failed (exit ${code})${hint}\n${stderr.trim()}`,
    );
  }
  return stdout;
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
