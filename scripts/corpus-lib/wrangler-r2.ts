import { spawn } from "node:child_process";
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
