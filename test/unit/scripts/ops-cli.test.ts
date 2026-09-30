import { describe, expect, it } from "vitest";
import { runCli } from "../../../scripts/ops-lib/cli";
import { UsageError, type AnyCommand, type BaseDeps, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { Registry } from "../../../scripts/ops-lib/registry";

function captureIo(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

function stubCommand(overrides: Partial<AnyCommand> = {}): AnyCommand & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    group: "corpus",
    name: "noop",
    summary: "A stub command",
    safety: "plan-first",
    helpText: "Options:\n  --execute  Act.",
    defaultDeps: (io: CommandIo): BaseDeps => ({ io }),
    run: async (argv: string[]) => {
      calls.push(argv);
      return 0;
    },
    calls,
    ...overrides,
  } as AnyCommand & { calls: string[][] };
}

describe("ops CLI dispatcher", () => {
  it("prints root help listing groups, commands, and safety labels with --help", async () => {
    const { io, out } = captureIo();
    const code = await runCli(["--help"], { io });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("corpus");
    expect(text).toContain("audit");
    expect(text).toContain("[plan-first]");
  });

  it("treats a bare invocation as a usage error but still prints root help", async () => {
    const { io, err } = captureIo();
    const code = await runCli([], { io });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Usage: npm run ops");
  });

  it("prints group help with --help after the group", async () => {
    const { io, out } = captureIo();
    const code = await runCli(["corpus", "--help"], { io });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("audit");
  });

  it("exits 2 with root help for an unknown group", async () => {
    const { io, err } = captureIo();
    const code = await runCli(["nope"], { io });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Unknown group: nope");
    expect(err.join("\n")).toContain("corpus");
  });

  it("exits 2 with group help for an unknown command", async () => {
    const { io, err } = captureIo();
    const code = await runCli(["corpus", "nope"], { io });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Unknown command: corpus nope");
    expect(err.join("\n")).toContain("audit");
  });

  it("prints command help and does not run the command with --help", async () => {
    const cmd = stubCommand();
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io, out } = captureIo();
    const code = await runCli(["corpus", "noop", "--help"], { io, registry });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("plan-first — prints a plan by default");
    expect(cmd.calls).toHaveLength(0);
  });

  it("rejects --execute on a read-only command without running it", async () => {
    const cmd = stubCommand({ safety: "read-only" });
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io, err } = captureIo();
    const code = await runCli(["corpus", "noop", "--execute"], { io, registry });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("read-only");
    expect(cmd.calls).toHaveLength(0);
  });

  it("passes remaining argv to the resolved command", async () => {
    const cmd = stubCommand();
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io } = captureIo();
    const code = await runCli(["corpus", "noop", "--execute", "--out", "x"], { io, registry });
    expect(code).toBe(0);
    expect(cmd.calls).toEqual([["--execute", "--out", "x"]]);
  });

  it("maps a UsageError from the command to exit 2 with command help", async () => {
    const cmd = stubCommand({
      run: async () => {
        throw new UsageError("bad flag combination");
      },
    });
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io, err } = captureIo();
    const code = await runCli(["corpus", "noop"], { io, registry });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("bad flag combination");
    expect(err.join("\n")).toContain("Usage: npm run ops -- corpus noop");
  });

  it("maps an operational error from the command to exit 1", async () => {
    const cmd = stubCommand({
      run: async () => {
        throw new Error("wrangler exploded");
      },
    });
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io, err } = captureIo();
    const code = await runCli(["corpus", "noop"], { io, registry });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("wrangler exploded");
  });

  it("preserves a command's own non-zero exit code", async () => {
    const cmd = stubCommand({ run: async () => 3 });
    const registry: Registry = { groups: [{ name: "corpus", summary: "g" }], commands: [cmd] };
    const { io } = captureIo();
    expect(await runCli(["corpus", "noop"], { io, registry })).toBe(3);
  });
});
