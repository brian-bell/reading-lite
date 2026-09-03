import { describe, expect, it, vi } from "vitest";
import { runDevSetup } from "../../../scripts/dev-setup";

describe("dev-setup", () => {
  it("applies local D1 migrations then bootstraps the founder principal", async () => {
    const calls: string[][] = [];
    const bootstrap = vi.fn().mockResolvedValue({ exitCode: 0 });

    const code = await runDevSetup({
      run: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return 0;
      },
      bootstrap,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(process.execPath);
    expect(calls[0]!.slice(1, 3)).toEqual(["--no-warnings", "--experimental-vm-modules"]);
    expect(calls[0]![3]).toMatch(/wrangler-dist[/\\]cli\.js$/);
    expect(calls[0]!.slice(4)).toEqual([
      "d1",
      "migrations",
      "apply",
      "reading-lite-control-dev",
      "--local",
    ]);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("stops when migrations fail", async () => {
    const bootstrap = vi.fn();

    const code = await runDevSetup({
      run: async () => 1,
      bootstrap,
    });

    expect(code).toBe(1);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
