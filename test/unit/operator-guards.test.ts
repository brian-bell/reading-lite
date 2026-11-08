// Operator tooling guards: the contracts that keep an operator command, a
// deploy, or a provider batch from damaging production. Each case fails
// closed — nothing remote, durable, or paid happens on the refusal path.

import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBatch } from "../../scripts/corpus-lib/batch/run";
import type { PersistedSidecar } from "../../scripts/corpus-lib/batch/types";
import { checkWipeDeployGate } from "../../scripts/lib/wipe-deploy-gate";
import { spawnWrangler } from "../../scripts/lib/wrangler-cli";
import { runCli } from "../../scripts/ops-lib/cli";
import { corpusRefreshStatusCommand, type RefreshStatusDeps, type RefreshStatusSql } from "../../scripts/ops-lib/commands/corpus-refresh-status";
import { assertRefreshStatusRead } from "../../scripts/ops-lib/refresh-status";
import { LOCAL_DATABASE_URL } from "../../scripts/pg-lib/local-postgres";
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
      "corpus refresh-status",
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

const REFRESH_TENANT = "usr_1700450b-c2df-4421-8805-c308a63b4dea";
const CURSOR_TOKEN = "cursor-token-secret";
const DATABASE_SECRET = "postgres://reading:super-secret-value@db.example/reading_lite";

function refreshTarget(id = "rd_a") {
  return { id, key_prefix: `readings/${id}` };
}

function refreshCursor(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    token: CURSOR_TOKEN,
    run_at: "2026-11-01T03:07:13.000Z",
    budget_at: "2026-11-01T03:07:13.000Z",
    limit: 100,
    dispatched: 1,
    targets: [refreshTarget()],
    scan_offset: 1,
    candidates: [refreshTarget()],
    judge_offset: 1,
    pending: [],
    tension_limit: 100,
    tension_dispatched: 0,
    tension_candidates: [],
    tension_offset: 0,
    tension_pending: [],
    repair_candidates: [],
    repair_offset: 0,
    repair_pending: [],
    ...extra,
  });
}

function refreshDeps(options: {
  body?: string | null;
  etag?: string;
  lastModified?: string;
  present?: boolean;
  failQuery?: boolean;
  env?: Record<string, string | undefined>;
  r2Error?: Error;
}): { queries: string[]; r2Calls: string[]; opened: string[]; io: ReturnType<typeof captureIo>; key: string; deps: RefreshStatusDeps } {
  const queries: string[] = [];
  const r2Calls: string[] = [];
  const opened: string[] = [];
  const io = captureIo();
  const key = `u/${REFRESH_TENANT}/index/refresh-cursor.json`;
  return {
    queries,
    r2Calls,
    opened,
    io,
    key,
    deps: {
      io: io.io,
      env: options.env ?? { PRODUCTION_DATABASE_URL: DATABASE_SECRET },
      loadVars: () => ({ CORPUS_R2_SECRET_KEY: "r2-secret-value-not-printed" }),
      openSql: (url: string): RefreshStatusSql => {
        opened.push(url);
        return {
          async query<Row extends Record<string, unknown>>(text: string): Promise<Row[]> {
            queries.push(text);
            if (options.failQuery) throw new Error(`connect failed ${DATABASE_SECRET}`);
            if (!/^\s*(select|with)\b/i.test(text)) throw new Error(`write attempted: ${text}`);
            let rows: Record<string, unknown>[];
            if (text.includes("to_regclass")) rows = [{ present: options.present !== false }];
            else if (text.includes("FROM relationship_refresh_jobs") && text.includes("AS total")) {
              rows = [{ total: 2, with_result: 1, no_result: 1, recent_retry: 0 }];
            } else if (text.includes("FROM relationship_refresh_jobs") && text.includes("GROUP BY")) {
              rows = [{ run_at: "2026-11-01T03:07:13.000Z", n: 2, with_result: 1 }];
            } else if (text.includes("FROM relationship_refresh_jobs")) {
              rows = [{ reading_id: "rd_a", run_at: "2026-11-01T03:07:13.000Z", retry_at: null }];
            } else if (text.includes("FROM tension_refresh_jobs") && text.includes("AS total")) {
              rows = [{ total: 1, with_result: 1, no_result: 0, recent_retry: 0 }];
            } else if (text.includes("FROM tension_refresh_jobs") && text.includes("GROUP BY run_at")) {
              rows = [{ run_at: "2026-11-01T03:07:13.000Z", n: 1, with_result: 1 }];
            } else if (text.includes("AS verdict")) rows = [{ verdict: "none", n: 1 }];
            else if (text.includes("FROM tension_refresh_jobs")) rows = [];
            else if (text.includes("tension_rows")) {
              rows = [{ tension_rows: 1, readings_with_tensions: 1, dangling: 1, one_sided: 0 }];
            } else if (text.includes("tensions_judged")) rows = [{ n: 0 }];
            else if (text.includes("kind = 'tension'")) rows = [{ source_id: "rd_a", target_id: "rd_missing" }];
            else throw new Error(`unexpected sql: ${text}`);
            return rows as Row[];
          },
          async end() {},
        };
      },
      openR2: () => {
        if (options.r2Error) throw options.r2Error;
        return {
          async get(objectKey: string) {
            r2Calls.push(`get ${objectKey}`);
            return options.body === undefined ? refreshCursor() : options.body;
          },
          async listObjects(prefix?: string) {
            r2Calls.push(`list ${prefix}`);
            if (options.body === null) return [];
            return [{
              key: prefix ?? key,
              etag: options.etag ?? "abc12345",
              lastModified: options.lastModified ?? "2026-11-01T03:07:20.000Z",
            }];
          },
        };
      },
    },
  };
}

describe("corpus refresh-status", () => {
  const argv = ["--tenant", REFRESH_TENANT, "--bucket", "reading-lite"];

  it("prints the cursor, checkpoints, verdict mix, and corpus counts, and only reads", async () => {
    const { deps, io, queries, r2Calls, opened } = refreshDeps({});
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], deps)).toBe(0);
    expect(opened).toEqual([DATABASE_SECRET]);
    expect(r2Calls).toEqual([
      `get u/${REFRESH_TENANT}/index/refresh-cursor.json`,
      `list u/${REFRESH_TENANT}/index/refresh-cursor.json`,
    ]);
    expect(queries.map((sql) => sql.trim().split("\n")[0])).toEqual([
      "SELECT count(*)::int AS total,",
      "SELECT run_at, count(*)::int AS n, count(result_json)::int AS with_result",
      "SELECT reading_id, run_at, retry_at",
      "SELECT to_regclass('public.tension_refresh_jobs') IS NOT NULL AS present",
      "SELECT count(*)::int AS total,",
      "SELECT run_at, count(*)::int AS n, count(result_json)::int AS with_result",
      "SELECT coalesce(result_json->'judgement'->>'verdict', '(no result)') AS verdict,",
      "SELECT reading_a, reading_b, run_at, retry_at",
      "WITH ready AS (",
      "SELECT count(*)::int AS n",
      "SELECT source_id, target_id",
    ]);
    const report = JSON.parse(io.out.join("\n"));
    expect(report).toEqual({
      tenant_id: REFRESH_TENANT,
      bucket: "reading-lite",
      local: false,
      cursor: {
        key: `u/${REFRESH_TENANT}/index/refresh-cursor.json`,
        status: "ok",
        value: {
          version: 1,
          run_at: "2026-11-01T03:07:13.000Z",
          budget_at: "2026-11-01T03:07:13.000Z",
          rollover: null,
          token_present: true,
          phase: "idle until next Sunday",
          fields: { tensions_555: true, repairs_556: true },
          scan: { targets: 1, offset: 1, remaining: 0 },
          repairs: { candidates: 0, offset: 0, pending: 0, remaining: 0 },
          judges: { candidates: 1, offset: 1, limit: 100, dispatched: 1, pending: 0, remaining: 0 },
          tensions: {
            candidates: 0, offset: 0, limit: 100, dispatched: 0, pending: 0, remaining_unsent: 0,
          },
          object: { status: "ok", etag: "abc12345", last_modified: "2026-11-01T03:07:20.000Z" },
        },
      },
      checkpoints: {
        connection: {
          status: "ok",
          value: {
            counts: { total: 2, with_result: 1, no_result: 1, recent_retry: 0 },
            by_run_at: [{ run_at: "2026-11-01T03:07:13.000Z", n: 2, with_result: 1 }],
            uncertain: [{ reading_id: "rd_a", run_at: "2026-11-01T03:07:13.000Z", retry_at: null }],
          },
        },
        tension: {
          status: "ok",
          value: {
            counts: { total: 1, with_result: 1, no_result: 0, recent_retry: 0 },
            by_run_at: [{ run_at: "2026-11-01T03:07:13.000Z", n: 1, with_result: 1 }],
            verdicts: [{ verdict: "none", n: 1 }],
            uncertain: [],
          },
        },
      },
      corpus: {
        status: "ok",
        value: {
          tension_rows: 1,
          readings_with_tensions: 1,
          dangling: 1,
          one_sided: 0,
          dangling_judged_records: 0,
          dangling_sample: [{ source_id: "rd_a", target_id: "rd_missing" }],
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain(CURSOR_TOKEN);
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
    expect(JSON.stringify(report)).not.toContain("r2-secret-value-not-printed");

    const text = refreshDeps({});
    expect(await corpusRefreshStatusCommand.run(argv, text.deps)).toBe(0);
    expect(text.io.out.join("\n")).toBe([
      `tenant ${REFRESH_TENANT}`,
      "bucket reading-lite",
      "local false",
      `cursor ok key=u/${REFRESH_TENANT}/index/refresh-cursor.json phase=idle until next Sunday run_at=2026-11-01T03:07:13.000Z budget_at=2026-11-01T03:07:13.000Z scan=1/1 repairs=0/0 repair_pending=0 judges=1/1 dispatched=1/100 judge_pending=0 tensions=0/0 tension_dispatched=0/100 tension_pending=0 tensions_555=true repairs_556=true etag=abc12345 last_modified=2026-11-01T03:07:20.000Z`,
      "checkpoints.connection ok total=2 with_result=1 no_result=1 recent_retry=0",
      "checkpoints.connection run_at=2026-11-01T03:07:13.000Z n=2 with_result=1",
      "checkpoints.connection uncertain reading_id=rd_a run_at=2026-11-01T03:07:13.000Z retry_at=null",
      "checkpoints.tension ok total=1 with_result=1 no_result=0 recent_retry=0 verdicts=none=1",
      "checkpoints.tension run_at=2026-11-01T03:07:13.000Z n=1 with_result=1",
      "corpus ok tension_rows=1 readings_with_tensions=1 dangling=1 one_sided=0 dangling_judged_records=0",
      "corpus dangling source_id=rd_a target_id=rd_missing",
    ].join("\n"));
  });

  it("keeps a missing cursor and a zero corpus distinct, and reports an unreadable cursor without failing the counts", async () => {
    const missing = refreshDeps({ body: null });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], missing.deps)).toBe(0);
    const missingReport = JSON.parse(missing.io.out.join("\n"));
    expect(missingReport.cursor).toEqual({
      key: `u/${REFRESH_TENANT}/index/refresh-cursor.json`,
      status: "missing",
      reason: "object not found",
    });
    expect(missingReport.corpus.value.tension_rows).toBe(1);
    expect(missing.r2Calls).toEqual([`get u/${REFRESH_TENANT}/index/refresh-cursor.json`]);

    const zeros = refreshDeps({
      body: null,
      present: true,
    });
    zeros.deps.openSql = (): RefreshStatusSql => ({
      async query<Row extends Record<string, unknown>>(text: string): Promise<Row[]> {
        let rows: Record<string, unknown>[];
        if (text.includes("to_regclass")) rows = [{ present: true }];
        else if (text.includes("AS total")) rows = [{ total: 0, with_result: 0, no_result: 0, recent_retry: 0 }];
        else if (text.includes("tension_rows")) {
          rows = [{ tension_rows: 0, readings_with_tensions: 0, dangling: 0, one_sided: 0 }];
        } else if (text.includes("tensions_judged")) rows = [{ n: 0 }];
        else rows = [];
        return rows as Row[];
      },
      async end() {},
    });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], zeros.deps)).toBe(0);
    const zeroReport = JSON.parse(zeros.io.out.join("\n"));
    expect(zeroReport.cursor.status).toBe("missing");
    expect(zeroReport.checkpoints.connection).toEqual({
      status: "ok",
      value: {
        counts: { total: 0, with_result: 0, no_result: 0, recent_retry: 0 },
        by_run_at: [],
        uncertain: [],
      },
    });
    expect(zeroReport.corpus.value).toEqual({
      tension_rows: 0,
      readings_with_tensions: 0,
      dangling: 0,
      one_sided: 0,
      dangling_judged_records: 0,
      dangling_sample: [],
    });

    const invalid = refreshDeps({ body: "not-json" });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], invalid.deps)).toBe(0);
    expect(JSON.parse(invalid.io.out.join("\n")).cursor).toEqual({
      key: `u/${REFRESH_TENANT}/index/refresh-cursor.json`,
      status: "invalid",
      reason: "cursor is not JSON",
    });

    const schema = refreshDeps({ body: JSON.stringify({ version: 2, token: CURSOR_TOKEN }) });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], schema.deps)).toBe(0);
    expect(JSON.parse(schema.io.out.join("\n")).cursor).toEqual({
      key: `u/${REFRESH_TENANT}/index/refresh-cursor.json`,
      status: "invalid",
      reason: "cursor does not match the refresh cursor schema",
    });
    expect(schema.io.out.join("\n")).not.toContain(CURSOR_TOKEN);
  });

  it("reports a pre-ship cursor as parsed with the new field groups absent", async () => {
    const body = JSON.parse(refreshCursor()) as Record<string, unknown>;
    delete body.tension_candidates;
    delete body.tension_offset;
    delete body.tension_pending;
    delete body.tension_dispatched;
    delete body.tension_limit;
    delete body.repair_candidates;
    delete body.repair_offset;
    delete body.repair_pending;
    const { deps, io } = refreshDeps({ body: JSON.stringify(body) });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], deps)).toBe(0);
    const cursor = JSON.parse(io.out.join("\n")).cursor.value;
    expect(cursor.fields).toEqual({ tensions_555: false, repairs_556: false });
    expect(cursor.phase).toBe("idle until next Sunday");
    expect(cursor.tensions.limit).toBeNull();
    expect(cursor.tensions.candidates).toBe(0);
  });

  it.each([
    ["sending connection judges", { pending: [refreshTarget()] }],
    ["scanning", { targets: [refreshTarget(), refreshTarget("rd_b")], scan_offset: 0, candidates: [], judge_offset: 0, dispatched: 0 }],
    ["reserving repairs", { repair_candidates: [{ a: "rd_a", b: "rd_b" }], repair_offset: 0 }],
  ])("names the cursor phase %s", async (phase, extra) => {
    const { deps, io } = refreshDeps({ body: refreshCursor(extra) });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], deps)).toBe(0);
    expect(JSON.parse(io.out.join("\n")).cursor.value.phase).toBe(phase);
  });

  it("rejects global scope, a mismatched database, and an unknown bucket before any read", async () => {
    const opened: string[] = [];
    const io = captureIo();
    const depsFor = () => ({
      io: io.io,
      env: { PRODUCTION_DATABASE_URL: DATABASE_SECRET, STAGING_DATABASE_URL: "postgres://staging:staging-secret@db.example/staging" },
      loadVars: () => ({}),
      openSql: (url: string) => {
        opened.push(url);
        throw new Error("opened");
      },
      openR2: () => {
        opened.push("r2");
        throw new Error("opened");
      },
    });
    expect(await runCli(["corpus", "refresh-status", "--tenant", "global"], { io: io.io, depsFor })).toBe(2);
    expect(io.err.join("\n")).toContain("--tenant global addresses the pre-tenant R2 layout");
    expect(opened).toEqual([]);

    const mismatch = captureIo();
    expect(await runCli(
      ["corpus", "refresh-status", "--tenant", REFRESH_TENANT, "--database-url-env", "STAGING_DATABASE_URL"],
      { io: mismatch.io, depsFor: () => depsFor() },
    )).toBe(2);
    expect(mismatch.err.join("\n")).toContain("names the staging database");
    expect(mismatch.err.join("\n")).not.toContain("staging-secret");
    expect(opened).toEqual([]);

    const bucket = captureIo();
    expect(await runCli(
      ["corpus", "refresh-status", "--tenant", REFRESH_TENANT, "--bucket", "not-a-bucket"],
      { io: bucket.io, depsFor: () => depsFor() },
    )).toBe(2);
    expect(bucket.err.join("\n")).toContain("no database is mapped to bucket 'not-a-bucket'");

    const local = captureIo();
    expect(await runCli(
      ["corpus", "refresh-status", "--tenant", REFRESH_TENANT, "--local", "--database-url-env", "PRODUCTION_DATABASE_URL"],
      { io: local.io, depsFor: () => depsFor() },
    )).toBe(2);
    expect(local.err.join("\n")).toContain("--local must never reach");
    expect(opened).toEqual([]);
  });

  it("reports an unset database and a failed read without printing secrets, and a missing tension table without zeroing it", async () => {
    const unset = refreshDeps({ env: {} });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], unset.deps)).toBe(1);
    const unsetReport = JSON.parse(unset.io.out.join("\n"));
    expect(unsetReport.cursor.status).toBe("ok");
    expect(unsetReport.checkpoints.connection.status).toBe("unavailable");
    expect(unsetReport.checkpoints.tension.status).toBe("unavailable");
    expect(unsetReport.corpus.status).toBe("unavailable");
    expect(unsetReport.checkpoints.connection.reason).toContain("PRODUCTION_DATABASE_URL");
    expect(unset.opened).toEqual([]);
    expect(unset.io.out.join("\n")).not.toContain("r2-secret-value-not-printed");

    const failed = refreshDeps({ failQuery: true });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], failed.deps)).toBe(1);
    const failedReport = JSON.parse(failed.io.out.join("\n"));
    expect(failedReport.cursor.status).toBe("ok");
    expect(failedReport.checkpoints.connection.status).toBe("failed");
    expect(failedReport.checkpoints.tension.status).toBe("failed");
    expect(failedReport.corpus.status).toBe("failed");
    const failedText = failed.io.out.join("\n");
    expect(failedText).not.toContain("super-secret-value");
    expect(failedText).not.toContain("postgres://");
    expect(failedReport.checkpoints.connection.reason).toContain("[redacted]");

    const r2 = refreshDeps({
      r2Error: new Error(`R2 GET failed ${DATABASE_SECRET}`),
    });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], r2.deps)).toBe(1);
    const r2Report = JSON.parse(r2.io.out.join("\n"));
    expect(r2Report.cursor.status).toBe("unavailable");
    expect(r2Report.checkpoints.connection.status).toBe("ok");
    expect(r2.io.out.join("\n")).not.toContain("super-secret-value");

    const table = refreshDeps({ present: false });
    expect(await corpusRefreshStatusCommand.run([...argv, "--json"], table.deps)).toBe(0);
    const tableReport = JSON.parse(table.io.out.join("\n"));
    expect(tableReport.checkpoints.connection.status).toBe("ok");
    expect(tableReport.checkpoints.tension).toEqual({
      status: "missing",
      reason: "tension_refresh_jobs is not installed",
    });
    expect(tableReport.corpus.status).toBe("ok");
    expect(table.queries.some((sql) => sql.includes("FROM tension_refresh_jobs"))).toBe(false);
  });

  it("uses the unprefixed cursor key and the local database for --local", async () => {
    const { deps, io, r2Calls, opened } = refreshDeps({ env: {} });
    expect(await corpusRefreshStatusCommand.run([...argv, "--local", "--json"], deps)).toBe(0);
    expect(r2Calls[0]).toBe("get index/refresh-cursor.json");
    expect(opened).toEqual([LOCAL_DATABASE_URL]);
    const report = JSON.parse(io.out.join("\n"));
    expect(report.local).toBe(true);
    expect(report.cursor.key).toBe("index/refresh-cursor.json");
    expect(io.out.join("\n")).not.toContain("reading_lite:reading_lite");
    expect(io.out.join("\n")).not.toContain("127.0.0.1");
  });

  it("refuses a statement that is not a read", () => {
    expect(() => assertRefreshStatusRead("DELETE FROM relationship_refresh_jobs WHERE tenant_id = $1")).toThrow(
      "refresh status refused a statement that is not a read",
    );
    expect(assertRefreshStatusRead("SELECT 1")).toBeUndefined();
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
