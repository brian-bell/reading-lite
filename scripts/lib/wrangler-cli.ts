// Launch the installed wrangler CLI on the current Node process.
//
// Ops and other script spawners exec `wrangler-dist/cli.js` with
// `process.execPath` so they do not depend on PATH or the npm bin wrapper.
// `npm run dev` and `types:generate` still use `bin/wrangler.js`. The Worker
// runtime is workerd.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export function resolveWranglerCliJs(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("wrangler/package.json")), "wrangler-dist", "cli.js");
}

export function wranglerSpawnArgs(wranglerArgs: readonly string[]): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["--no-warnings", "--experimental-vm-modules", resolveWranglerCliJs(), ...wranglerArgs],
  };
}

/** Rewrite a `(cmd, args)` pair so `wrangler` / `npx wrangler` skip `bin/wrangler.js`. */
export function rewriteWranglerCommand(
  cmd: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (cmd === "wrangler") return wranglerSpawnArgs(args);
  if (cmd === "npx" && args[0] === "wrangler") return wranglerSpawnArgs(args.slice(1));
  return { command: cmd, args: [...args] };
}

export function spawnWrangler(wranglerArgs: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const launched = wranglerSpawnArgs(wranglerArgs);
  return spawn(launched.command, launched.args, { shell: false, ...options });
}

export function spawnCommand(cmd: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const launched = rewriteWranglerCommand(cmd, args);
  return spawn(launched.command, launched.args, { shell: false, ...options });
}
