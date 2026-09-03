// Launch the installed wrangler CLI on the current Node process.
//
// Wrangler 4.87+ hard-fails in `bin/wrangler.js` when Node < 22. The supported
// operator path for `npm run ops` is Debian `/usr/bin/node` 20.19.x (Node 22
// will not launch under that security boundary). The CLI payload at
// `wrangler-dist/cli.js` still runs on 20.19.x — this helper skips the wrapper
// and execs that file with `process.execPath`. CI remains Node 22; the Worker
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
