// Operator tooling guards: the contracts that keep an operator command, a
// deploy, or a provider batch from damaging production. Each case fails
// closed — nothing remote, durable, or paid happens on the refusal path.
//
// Pure: no database, so CI's Ops CLI job (which has no Postgres service) runs
// this file too.

import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBatch } from "../../scripts/corpus-lib/batch/run";
import type { PersistedSidecar } from "../../scripts/corpus-lib/batch/types";
import { checkWipeDeployGate } from "../../scripts/lib/wipe-deploy-gate";
import { spawnWrangler } from "../../scripts/lib/wrangler-cli";
import { runCli } from "../../scripts/ops-lib/cli";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../scripts/ops-lib/commands/deploy-worker";
import type { CommandIo } from "../../scripts/ops-lib/contract";
import { defaultRegistry } from "../../scripts/ops-lib/registry";
import type { MigrationFile } from "../../scripts/pg-lib/migrate";
import {
  APP_FIXTURE_PACK_COMMAND,
  APP_FIXTURE_PACK_PATH,
  buildAppFixturePack,
  serializeAppFixturePack,
} from "../fixtures/app-fixture-pack";
import {
  APP_SAMPLE_LIBRARY_PATH,
  buildAppSampleLibrary,
  serializeAppSampleLibrary,
} from "../fixtures/app-sample-library";
import { harness, manifest, row } from "../helpers/batch-run-harness";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function captureIo(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

describe("ops registry", () => {
  // The --tenant gate is single-homed in scripts/ops-lib/tenant-flag.ts, so one
  // loop over the registry pins it for every command that touches tenant data.
  it("fails every corpus and export command closed without --tenant (exit 2)", async () => {
    // Commands whose own required arguments are parsed before the tenant
    // selector; this argv satisfies them so the failure is the tenant's.
    const MINIMAL_ARGV: Record<string, string[]> = {
      "corpus ingest": ["--dir", "/md"],
      "corpus drop": ["rd_f"],
      "corpus purge-connections": ["--id", "rd_0123456789"],
    };
    const gated = defaultRegistry.commands.filter((c) => c.group === "corpus" || c.group === "export");
    expect(gated.map((c) => `${c.group} ${c.name}`).sort()).toEqual([
      "corpus audit",
      "corpus drop",
      "corpus ingest",
      "corpus purge-connections",
      "corpus recover",
      "corpus redact-key-echoes",
      "corpus refresh-connections",
      "corpus refresh-neighbours",
      "corpus refresh-tensions",
      "corpus sweep",
      "export cancel",
      "export inspect",
    ]);
    for (const cmd of gated) {
      const { io, err } = captureIo();
      const route = `${cmd.group} ${cmd.name}`;
      expect(await runCli([cmd.group, cmd.name, ...(MINIMAL_ARGV[route] ?? [])], { io }), route).toBe(2);
      expect(err.join("\n"), route).toContain("--tenant is required");
    }
  });

  it("rejects --execute on every read-only command (exit 2)", async () => {
    for (const cmd of defaultRegistry.commands.filter((c) => c.safety === "read-only")) {
      const { io } = captureIo();
      expect(await runCli([cmd.group, cmd.name, "--execute"], { io }), `${cmd.group} ${cmd.name}`).toBe(2);
    }
  });
});

describe("ops deploy worker", () => {
  const pending: MigrationFile = { version: "0006", name: "reading_source_date", sql: "-- 0006", checksum: "0006".repeat(8) };
  const PRODUCTION = ["--env", "production", "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"];

  function deps(options: { migrateFails?: boolean; connectFails?: boolean; drift?: boolean; env?: Record<string, string> } = {}) {
    const order: string[] = [];
    const err: string[] = [];
    const runWrangler = vi.fn(async () => {
      order.push("wrangler");
      return 0;
    });
    const connect = vi.fn(async () => {
      order.push("migrations");
      if (options.connectFails) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      return {
        async query(text: string) {
          if (options.migrateFails && text === pending.sql) throw new Error('relation "readings" does not exist');
          // planMigrations' probe; an absent table means nothing is applied yet.
          if (text.includes("to_regclass")) return { rows: [{ present: Boolean(options.drift) }] };
          // Drift: a recorded migration with no file on disk.
          if (options.drift && text.includes("FROM schema_migrations")) {
            return { rows: [{ version: "0001", name: "vanished", checksum: "c".repeat(8) }] };
          }
          return { rows: [] };
        },
        async end() {},
      };
    });
    const built: DeployWorkerDeps = {
      io: { stdout: () => {}, stderr: (text) => err.push(text) },
      runWrangler,
      validateTenantActivation: vi.fn(async () => ({ ok: true, message: "already enabled" })),
      checkHyperdriveBinding: vi.fn(() => ({ ok: true, bound: false }) as const),
      env: options.env ?? { PRODUCTION_DATABASE_URL: "postgres://production", STAGING_DATABASE_URL: "postgres://staging" },
      readMigrations: () => (options.drift ? [] : [pending]),
      connect,
    };
    return { built, order, err, runWrangler, connect };
  }

  it("applies pending migrations before the upload", async () => {
    const { built, order } = deps();
    expect(await deployWorkerCommand.run(PRODUCTION, built)).toBe(0);
    expect(order).toEqual(["migrations", "wrangler"]);
  });

  it("uploads nothing when the migration fails, the database is unreachable, history drifted, or the URL is unset", async () => {
    const cases = [
      ["migration SQL fails", { migrateFails: true }, "migrations FAILED; nothing uploaded"],
      ["database unreachable", { connectFails: true }, "migrations FAILED; nothing uploaded"],
      ["drift", { drift: true }, "Migration drift"],
      ["URL unset", { env: {} }, "PRODUCTION_DATABASE_URL is not set"],
    ] as const;
    for (const [label, options, message] of cases) {
      const { built, err, runWrangler } = deps(options);
      expect(await deployWorkerCommand.run(PRODUCTION, built), label).toBe(1);
      expect(runWrangler, label).not.toHaveBeenCalled();
      expect(err.join("\n"), label).toContain(message);
    }
  });

  it("refuses an --env and --database-url-env that do not pair, before any remote call", async () => {
    const cases = [
      ["production", "STAGING_DATABASE_URL", "names the staging database"],
      ["staging", "PRODUCTION_DATABASE_URL", "names the production database"],
      ["production", "NEON_DEV_DATABASE_URL", "does not name a production database"],
      ["production", "DATABASE_URL", "does not name a production database"],
    ] as const;
    for (const [env, name, message] of cases) {
      const { built, runWrangler, connect } = deps();
      await expect(deployWorkerCommand.run(["--env", env, "--execute", "--database-url-env", name], built), name).rejects.toThrow(
        message,
      );
      expect(built.checkHyperdriveBinding, name).not.toHaveBeenCalled();
      expect(built.validateTenantActivation, name).not.toHaveBeenCalled();
      expect(connect, name).not.toHaveBeenCalled();
      expect(runWrangler, name).not.toHaveBeenCalled();
    }
  });

  it("blocks on unfinished wipes or either wipe-queue backlog, and fails closed on an unreadable count", async () => {
    const queues = [
      { queue_name: "reading-lite-wipe", queue_id: "a".repeat(32) },
      { queue_name: "reading-lite-wipe-dlq", queue_id: "b".repeat(32) },
    ];
    const ok = (result: unknown) => ({ success: true, result });
    const gate = (overrides: Record<string, unknown>, unfinishedWipes: () => Promise<number>) => {
      const payloads: Record<string, unknown> = {
        list: { ...ok(queues), result_info: { page: 1, total_pages: 1 } },
        wipe: ok({ backlog_count: 0 }),
        dlq: ok({ backlog_count: 0 }),
        ...overrides,
      };
      const fetcher = async (input: string | URL | Request) => {
        const url = String(input);
        const key = url.includes("/metrics") ? (url.includes("b".repeat(32)) ? "dlq" : "wipe") : "list";
        return Response.json(payloads[key]);
      };
      return checkWipeDeployGate({ accountId: "account", token: "secret", unfinishedWipes, fetch: fetcher as typeof fetch });
    };

    await expect(gate({}, async () => 0)).resolves.toEqual({
      unfinished: 0,
      queues: { "reading-lite-wipe": 0, "reading-lite-wipe-dlq": 0 },
    });
    await expect(gate({}, async () => 1), "unfinished wipe").rejects.toThrow(/refusing/i);
    await expect(gate({ wipe: ok({ backlog_count: 1 }) }, async () => 0), "wipe backlog").rejects.toThrow(/refusing/i);
    await expect(gate({ dlq: ok({ backlog_count: 1 }) }, async () => 0), "dlq backlog").rejects.toThrow(/refusing/i);
    await expect(
      gate({}, async () => {
        throw new Error("missing DATABASE_URL");
      }),
    ).rejects.toThrow("missing DATABASE_URL");
  });

  // deploy-worker, staging and the activation preflight launch wrangler this
  // way; this is the only pre-merge proof that it starts under the runner's Node.
  it("launches wrangler under the current Node", async () => {
    const child: ChildProcess = spawnWrangler(["--version"]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? 1));
    });
    const out = Buffer.concat(stdout).toString("utf8");
    const errText = Buffer.concat(stderr).toString("utf8");
    expect(code, errText).toBe(0);
    expect(out + errText).not.toMatch(/Please update your version of Node\.js|requires at least Node\.js/i);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("corpus provider batches", () => {
  it("admits spend before the first pending sidecar, saves that sidecar before create, then settles", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const events: string[] = [];
    const rpc = h.deps.spend.rpc;
    h.deps.spend = {
      ...h.deps.spend,
      rpc: async (body) => {
        events.push(String(body.kind));
        return rpc(body);
      },
    };
    const save = h.deps.saveSidecar;
    h.deps.saveSidecar = async (s) => {
      events.push(`sidecar:${s.phase}`);
      await save(s);
    };
    const create = h.batch.create;
    h.batch.create = vi.fn(async (requests: Array<{ custom_id: string }>) => {
      events.push("create");
      return create(requests);
    });

    const result = await runBatch([row("rd_a")], h.deps);

    expect(events).toEqual([
      "reserve_spend",
      "mark_spend_dispatched",
      "sidecar:activating",
      "sidecar:creating",
      "create",
      "sidecar:submitted",
      "settle_spend",
    ]);
    expect(result.spend).toMatchObject({ state: "settled", actualMicrodollars: 83 });
  });

  // A sidecar with no batch id means a create may have reached the provider.
  // Creating again could bill the same work twice, so the run stops instead.
  it("never creates a batch again over an ambiguous creating or activating sidecar", async () => {
    const ambiguous = { version: 2, provider: "anthropic", batchId: "", model: "m", resultsUrl: null, targets: [] } as const;
    const sidecars: PersistedSidecar[] = [
      { ...ambiguous, phase: "creating", processingStatus: "pending", targets: [] },
      { ...ambiguous, phase: "activating", processingStatus: "activating", targets: [] },
    ];
    for (const sidecar of sidecars) {
      const phase = sidecar.phase;
      const h = harness({ rd_a: manifest("rd_a") });
      h.deps.loadSidecar = vi.fn(async () => sidecar);
      await expect(runBatch([row("rd_a")], h.deps), phase).rejects.toThrow(/sidecar with no batch id/i);
      expect(h.batch.create, phase).not.toHaveBeenCalled();
      expect(h.r2.put, phase).not.toHaveBeenCalled();
      expect(h.deps.embed.embedMany, phase).not.toHaveBeenCalled();
    }
  });
});

describe("committed app fixtures", () => {
  // Both files are generated from test/fixtures/local-seed.ts; this is their
  // drift guard. Edit the seed, run the regenerate command, commit all three.
  it("match their projection of the local fixture pack", () => {
    const generated = [
      [APP_FIXTURE_PACK_PATH, serializeAppFixturePack(buildAppFixturePack())],
      [APP_SAMPLE_LIBRARY_PATH, serializeAppSampleLibrary(buildAppSampleLibrary())],
    ] as const;
    for (const [file, expected] of generated) {
      const committed = readFileSync(path.join(repoRoot, file), "utf8");
      expect(committed, `stale ${file}; run \`${APP_FIXTURE_PACK_COMMAND}\``).toBe(expected);
    }
  });
});
