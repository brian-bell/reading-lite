import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWranglerCliJs,
  rewriteWranglerCommand,
  spawnWrangler,
  wranglerSpawnArgs,
} from "../../../scripts/lib/wrangler-cli";

function captured(child: ChildProcess): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

describe("wrangler CLI launcher", () => {
  it("resolves wrangler-dist/cli.js, not the npm bin wrapper", () => {
    const cli = resolveWranglerCliJs();
    expect(cli.replaceAll("\\", "/")).toMatch(/\/wrangler-dist\/cli\.js$/);
    expect(cli.replaceAll("\\", "/")).not.toMatch(/\/bin\/wrangler\.js$/);

    const wrapper = path.join(path.dirname(cli), "..", "bin", "wrangler.js");
    expect(readFileSync(wrapper, "utf8")).toMatch(/MIN_NODE_VERSION\s*=\s*"22\.0\.0"/);
  });

  it("execs the current Node rather than a PATH wrangler binary", () => {
    const launched = wranglerSpawnArgs(["r2", "object", "get", "--help"]);
    expect(launched.command).toBe(process.execPath);
    expect(launched.args.slice(0, 3)).toEqual([
      "--no-warnings",
      "--experimental-vm-modules",
      resolveWranglerCliJs(),
    ]);
    expect(launched.args.slice(3)).toEqual(["r2", "object", "get", "--help"]);
  });

  it("rewrites wrangler and npx wrangler, and leaves other commands alone", () => {
    const viaBin = rewriteWranglerCommand("wrangler", ["whoami"]);
    expect(viaBin).toEqual(wranglerSpawnArgs(["whoami"]));

    const viaNpx = rewriteWranglerCommand("npx", ["wrangler", "r2", "object", "get", "reading-lite/index/list.json"]);
    expect(viaNpx).toEqual(
      wranglerSpawnArgs(["r2", "object", "get", "reading-lite/index/list.json"]),
    );

    expect(rewriteWranglerCommand(process.execPath, ["-e", "0"])).toEqual({
      command: process.execPath,
      args: ["-e", "0"],
    });
  });

  it("runs wrangler --version", async () => {
    const result = await captured(spawnWrangler(["--version"]));
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/Wrangler requires at least Node\.js v22/i);
    expect(result.stdout + result.stderr).not.toMatch(/Please update your version of Node\.js/);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is imported by every default wrangler spawner the ops CLI uses", () => {
    const spawners = [
      "scripts/corpus-lib/wrangler-r2.ts",
      "scripts/corpus-lib/wrangler-put.ts",
      "scripts/ops-lib/commands/deploy-worker.ts",
      "scripts/ops-lib/commands/deploy-web.ts",
      "scripts/staging-env.ts",
      "scripts/lib/founder-bootstrap.ts",
    ];
    for (const file of spawners) {
      const src = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(src, file).toMatch(/wrangler-cli["']/);
      expect(src, file).not.toMatch(/spawn\(\s*["']wrangler["']/);
    }
  });
});
