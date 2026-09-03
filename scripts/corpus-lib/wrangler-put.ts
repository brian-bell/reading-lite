// Single-manifest put via the wrangler R2 CLI (temp file + `r2 object put`).
// Shared by the similarity backfill, neighbour refresh, and tag normalization,
// which each rewrite exactly one manifest field per reading.

import { spawnCommand } from "../lib/wrangler-cli";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { R2Deps, Runner } from "./wrangler-r2";
import { MANIFEST_FILE, r2KeyLayout } from "../../src/modules/stores/layout";

// Relative-key spelling only: keys built here are handed to a tenant-rooted
// client (withKeyRoot) or tenant-rooted R2Deps, which apply the operator's
// --tenant key root. This module never sees the root (s1k.4.3).
const layout = r2KeyLayout();

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawnCommand(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export async function putManifest(keyPrefix: string, body: unknown, deps: R2Deps): Promise<void> {
  const run = deps.run ?? defaultRunner;
  const dir = await mkdtemp(join(tmpdir(), "corpus-manifest-"));
  const file = join(dir, MANIFEST_FILE);
  try {
    await writeFile(file, JSON.stringify(body), "utf8");
    const args = [
      "r2", "object", "put", `${deps.bucket}/${deps.keyRoot}${layout.manifestKey(keyPrefix)}`,
      "--file", file, "--content-type", "application/json",
    ];
    if (deps.remote !== false) args.push("--remote");
    const { code, stderr } = await run("wrangler", args);
    if (code !== 0) throw new Error(`put manifest failed: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
