import { describe, expect, it } from "vitest";
import {
  corpusPurgeConnectionsCommand,
  type CorpusPurgeConnectionsDeps,
  type PurgeConnectionsView,
} from "../../../scripts/ops-lib/commands/corpus-purge-connections";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";
import type { Manifest } from "../../../src/schemas/manifest";

const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const TARGET = "rd_01ABCDEFGH";

interface Harness {
  deps: CorpusPurgeConnectionsDeps;
  out: string[];
  err: string[];
  deleted: string[];
  counted: string[];
}

function harness(
  opts: { targetExists?: boolean; inbound?: number; throwOnDelete?: Error } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const deleted: string[] = [];
  const counted: string[] = [];
  const io: CommandIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };

  const view: PurgeConnectionsView = {
    manifest: async (id: string) => (opts.targetExists && id === TARGET ? ({ id } as Manifest) : null),
    keyPrefix: async () => null,
    ownerByUrl: async () => null,
    countInboundRelationships: async (id: string) => {
      counted.push(id);
      return opts.inbound ?? 0;
    },
    deleteInboundRelationships: async (id: string) => {
      if (opts.throwOnDelete) throw opts.throwOnDelete;
      deleted.push(id);
      return opts.inbound ?? 0;
    },
    deleteReading: async () => false,
  } as never;

  const deps: CorpusPurgeConnectionsDeps = {
    io,
    corpus: async (_env, tenant, run) => {
      if (tenant.kind === "global") throw new UsageError("--tenant global has no PostgreSQL corpus");
      return run(view);
    },
  };
  return { deps, out, err, deleted, counted };
}

const audit = (out: string[]) => JSON.parse(out[out.length - 1]!);

describe("ops corpus purge-connections", () => {
  it("plans by counting, and deletes nothing", async () => {
    const { deps, out, deleted, counted } = harness({ inbound: 3 });
    const code = await corpusPurgeConnectionsCommand.run(["--tenant", TENANT, "--id", TARGET], deps);
    expect(code).toBe(0);
    expect(deleted).toEqual([]);
    expect(counted).toEqual([TARGET]);
    expect(audit(out)).toMatchObject({ mode: "plan", rows_to_remove: 3, rows_removed: 0, failures: 0 });
  });

  it("--execute removes the inbound rows and reports how many", async () => {
    const { deps, out, deleted } = harness({ inbound: 2 });
    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", TENANT, "--id", TARGET, "--execute"],
      deps,
    );
    expect(code).toBe(0);
    expect(deleted).toEqual([TARGET]);
    expect(audit(out)).toMatchObject({ mode: "execute", rows_removed: 2, failures: 0 });
  });

  // Purging references to a live reading would delete real relationships.
  it("refuses when the target still exists", async () => {
    const { deps, out, err, deleted } = harness({ targetExists: true, inbound: 5 });
    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", TENANT, "--id", TARGET, "--execute"],
      deps,
    );
    expect(code).toBe(1);
    expect(deleted).toEqual([]);
    expect(err.join("\n")).toContain("still exists");
    expect(audit(out)).toMatchObject({ failure_code: "target_present", failures: 1 });
  });

  it("refuses a malformed id before opening anything", async () => {
    const { deps, out, counted } = harness();
    const code = await corpusPurgeConnectionsCommand.run(["--tenant", TENANT, "--id", "nope"], deps);
    expect(code).toBe(2);
    expect(counted).toEqual([]);
    expect(audit(out)).toMatchObject({ failure_code: "invalid_target" });
  });

  it("reports a storage failure as an audit row rather than throwing", async () => {
    const { deps, out, err } = harness({ throwOnDelete: new Error("connection reset") });
    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", TENANT, "--id", TARGET, "--execute"],
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("connection reset");
    expect(audit(out)).toMatchObject({ failure_code: "storage_error", failures: 1 });
  });

  // The old sweep read every manifest and rewrote matches with CAS, so a
  // concurrent writer could reintroduce an entry it had already passed. One
  // DELETE cannot, so the flag is accepted for old runbooks and ignored.
  it("no longer requires --sole-writer, but still accepts it", async () => {
    const { deps, deleted } = harness({ inbound: 1 });
    const code = await corpusPurgeConnectionsCommand.run(
      ["--tenant", TENANT, "--id", TARGET, "--execute", "--sole-writer"],
      deps,
    );
    expect(code).toBe(0);
    expect(deleted).toEqual([TARGET]);
  });

  it("requires --id and a tenant", async () => {
    const { deps } = harness();
    await expect(corpusPurgeConnectionsCommand.run(["--tenant", TENANT], deps)).rejects.toThrow(UsageError);
    await expect(corpusPurgeConnectionsCommand.run(["--id", TARGET], deps)).rejects.toThrow(UsageError);
    await expect(
      corpusPurgeConnectionsCommand.run(["--tenant", "global", "--id", TARGET], deps),
    ).rejects.toThrow(UsageError);
  });

  it("is registered as plan-first", () => {
    expect(corpusPurgeConnectionsCommand.safety).toBe("plan-first");
  });
});
