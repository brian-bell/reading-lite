import { describe, expect, it } from "vitest";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../../scripts/ops-lib/commands/deploy-worker";
import { stagingSetupCommand, type StagingSetupDeps } from "../../../scripts/ops-lib/commands/staging-setup";
import {
  stagingTeardownCommand,
  type StagingTeardownDeps,
} from "../../../scripts/ops-lib/commands/staging-teardown";
import { stagingSmokeCommand, type StagingSmokeDeps } from "../../../scripts/ops-lib/commands/staging-smoke";
import {
  founderBootstrapCommand,
  type FounderBootstrapCommandDeps,
} from "../../../scripts/ops-lib/commands/founder-bootstrap";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";

function io(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

describe("ops deploy worker", () => {
  function makeDeps() {
    const { io: cio, err } = io();
    const runs: string[][] = [];
    const deps: DeployWorkerDeps = {
      io: cio,
      validateTenantActivation: async () => ({ ok: true, message: "already enabled" }),
      // The PostgreSQL cutover guard has its own owner: test/unit/deploy/postgres-cutover.test.ts.
      checkHyperdriveBinding: () => ({ ok: true, bound: false }),
      runWrangler: async (args) => {
        runs.push(args);
        return 0;
      },
      // The migration step has its own owner: test/unit/deploy/deploy-worker-migrations.test.ts.
      env: { STAGING_DATABASE_URL: "postgres://staging", PRODUCTION_DATABASE_URL: "postgres://production" },
      readMigrations: () => [],
      connect: async () => ({ query: async () => ({ rows: [{ present: false }] }), end: async () => {} }),
    };
    return { deps, err, runs };
  }

  it("tags an explicitly verified candidate and refuses an unverified checkout before writes", async () => {
    const sha = "a".repeat(40);
    const { deps, runs } = makeDeps();
    deps.validateCandidate = async candidate => { expect(candidate).toBe(sha); };
    expect(await deployWorkerCommand.run(["--env", "staging", "--release-sha", sha, "--execute", "--database-url-env", "STAGING_DATABASE_URL"], deps)).toBe(0);
    expect(runs[0]).toEqual(["deploy", "--env", "staging", "--tag", sha]);
    runs.length = 0;
    deps.validateCandidate = async () => { throw new Error("dirty or mismatched checkout"); };
    await expect(deployWorkerCommand.run(["--release-sha", sha, "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], deps)).rejects.toThrow("checkout");
    expect(runs).toEqual([]);
  });

  it("plan mode passes wrangler --dry-run and names the secrets the environment must hold", async () => {
    const { deps, err, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL"], deps)).toBe(0);
    expect(runs).toEqual([["deploy", "--env", "staging", "--dry-run"]]);
    expect(err.join("\n")).toContain("required runtime secret: AUTH_ROOT_SECRET");
    expect(err.join("\n")).toContain("bootstrap-only secret: READER_API_TOKEN");
  });

  it("--execute uploads without --dry-run", async () => {
    const { deps, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging", "--execute", "--database-url-env", "STAGING_DATABASE_URL"], deps)).toBe(0);
    expect(runs).toEqual([["deploy", "--env", "staging"]]);
  });

  it("rejects an invalid env", async () => {
    const { deps } = makeDeps();
    await expect(deployWorkerCommand.run(["--env", "dev", "--database-url-env", "STAGING_DATABASE_URL"], deps)).rejects.toThrow(UsageError);
  });

  it("refuses unverified activation before the upload", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "off to on; 1 deletion-eligible tenant: usr_due" });
    expect(await deployWorkerCommand.run(["--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], deps)).toBe(2);
    expect(runs).toHaveLength(0);
    expect(err.join("\n")).toContain("usr_due");
    expect(err.join("\n")).toContain("--acknowledge-tenant-migration");
  });

  it("allows the explicit manual acknowledgement and logs it", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "unknown activation state" });
    expect(await deployWorkerCommand.run(["--execute", "--acknowledge-tenant-migration", "--database-url-env", "PRODUCTION_DATABASE_URL"], deps)).toBe(0);
    expect(runs.map(args => args[0])).toEqual(["deploy"]);
    expect(err.join("\n")).toContain("OVERRIDE");
  });

  it("does not inspect remote activation state in plan mode, even with acknowledgement", async () => {
    const { deps } = makeDeps();
    deps.validateTenantActivation = async () => { throw new Error("unexpected remote inspection"); };
    expect(await deployWorkerCommand.run(["--acknowledge-tenant-migration", "--database-url-env", "PRODUCTION_DATABASE_URL"], deps)).toBe(0);
  });
});

describe("ops staging setup / teardown", () => {
  // A staging database with one pending migration. Records every step, so a
  // test can read the order in which the database and Cloudflare are touched.
  function setupDeps(overrides: Partial<StagingSetupDeps> & { dbState?: "ok" | "unreachable" | "fails" | "drift" } = {}) {
    const { dbState = "ok", ...rest } = overrides;
    const order: string[] = [];
    const { io: cio, out, err } = io();
    const deps: StagingSetupDeps = {
      io: cio,
      env: { STAGING_DATABASE_URL: "postgres://staging-secret@host/db" },
      readMigrations: () => [{ version: "0001", name: "init", sql: "CREATE EXTENSION vector", checksum: "c1" }],
      connect: async (url) => {
        order.push(`connect:${url}`);
        if (dbState === "unreachable") throw new Error("connection refused");
        return {
          query: async (text: string) => {
            if (text === "CREATE EXTENSION vector") {
              if (dbState === "fails") throw new Error("permission denied to create extension");
              order.push("db:migrated");
            }
            // Drift: an applied migration with no file behind it.
            if (dbState === "drift") return { rows: [{ present: true, version: "0009", name: "gone", checksum: "x" }] };
            return { rows: [{ present: false }] };
          },
          end: async () => {
            order.push("db:end");
          },
        };
      },
      runWranglerCommands: async (commands) => {
        order.push(`wrangler:${commands.length}`);
        return 0;
      },
      ...rest,
    };
    return { deps, order, out, err };
  }

  it("plan reads the staging database read-only and never runs wrangler", async () => {
    const { deps, order, out, err } = setupDeps();
    expect(await stagingSetupCommand.run([], deps)).toBe(0);
    expect(order).toEqual(["connect:postgres://staging-secret@host/db", "db:end"]);
    expect(out.join("\n")).toContain("[PLAN] database from STAGING_DATABASE_URL");
    expect(out.join("\n")).toContain("pending 0001_init");
    expect(`${out.join("\n")}\n${err.join("\n")}`).not.toContain("staging-secret");
  });

  it("execute migrates the paired staging database before any Cloudflare mutation", async () => {
    const { deps, order, out, err } = setupDeps();
    expect(await stagingSetupCommand.run(["--execute"], deps)).toBe(0);
    const firstWrangler = order.findIndex((step) => step.startsWith("wrangler"));
    expect(order.slice(0, firstWrangler)).toEqual(["connect:postgres://staging-secret@host/db", "db:migrated", "db:end"]);
    expect(firstWrangler).toBe(3);
    expect(out.join("\n")).toContain("[EXECUTE] applied 0001_init");
    expect(`${out.join("\n")}\n${err.join("\n")}`).not.toContain("staging-secret");
  });

  it("uses the laptop alias when only NEON_REHEARSAL_DATABASE_URL is set", async () => {
    const { deps, order } = setupDeps({ env: { NEON_REHEARSAL_DATABASE_URL: "postgres://rehearsal" } });
    expect(await stagingSetupCommand.run(["--execute"], deps)).toBe(0);
    expect(order[0]).toBe("connect:postgres://rehearsal");
  });

  it.each<[string, string[], Record<string, string> | undefined]>([
    ["--database-url-env names the production database", ["--database-url-env", "NEON_MAIN_DATABASE_URL"], undefined],
    ["--database-url-env is bare DATABASE_URL", ["--database-url-env", "DATABASE_URL"], { DATABASE_URL: "postgres://x" }],
  ])("refuses before touching anything when %s", async (_name, argv, env) => {
    const { deps, order } = setupDeps(env ? { env } : {});
    for (const mode of [[], ["--execute"]]) {
      await expect(stagingSetupCommand.run([...argv, ...mode], deps)).rejects.toBeInstanceOf(UsageError);
    }
    expect(order).toEqual([]);
  });

  it("execute refuses before touching anything when no staging database is set", async () => {
    const { deps, order } = setupDeps({ env: { DATABASE_URL: "postgres://x" } });
    await expect(stagingSetupCommand.run(["--execute"], deps)).rejects.toBeInstanceOf(UsageError);
    expect(order).toEqual([]);
  });

  // A plan still prints the Cloudflare plan when the migrations cannot be
  // inspected; only a history it did read and cannot act on fails it.
  it.each<[string, Partial<Parameters<typeof setupDeps>[0]>, number, RegExp]>([
    ["no staging database is set", { env: {} }, 0, /no staging database variable is set; migrations uninspected/],
    ["the database is unreachable", { dbState: "unreachable" }, 0, /could not reach the staging database/],
    ["the migration history has drifted", { dbState: "drift" }, 1, /not something setup can act on/],
  ])("plan when %s", async (_name, overrides, code, message) => {
    const { deps, order, err } = setupDeps(overrides);
    expect(await stagingSetupCommand.run([], deps)).toBe(code);
    expect(order.some((step) => step.startsWith("wrangler"))).toBe(false);
    expect(err.join("\n")).toMatch(message);
    expect(err.join("\n")).toContain("[PLAN] $ wrangler r2 bucket create reading-lite-staging");
  });

  it.each([
    ["unreachable", "unreachable" as const],
    ["failing a migration", "fails" as const],
    ["drifted", "drift" as const],
  ])("execute with the database %s creates no Cloudflare resources", async (_name, dbState) => {
    const { deps, order } = setupDeps({ dbState });
    expect(await stagingSetupCommand.run(["--execute"], deps)).toBe(1);
    expect(order.some((step) => step.startsWith("wrangler"))).toBe(false);
  });

  it("teardown has no database step and its plan says the database is retained", async () => {
    const { io: cio, err } = io();
    const ran: string[][] = [];
    const deps: StagingTeardownDeps = {
      io: cio,
      runWranglerCommands: async (commands) => {
        ran.push(...commands.map((command) => command.args));
        return 0;
      },
      resolveBucketEmptier: async () => ({ empty: async () => {} }),
    };
    expect(await stagingTeardownCommand.run(["--execute"], deps)).toBe(0);
    expect(ran.flat().join(" ")).not.toMatch(/\bd1\b|database|postgres|neon/i);
    expect(err.join("\n")).toMatch(/staging PostgreSQL database is retained/i);
  });

  it("teardown plans without acting, then executes preflight → commands → empty bucket → bucket delete", async () => {
    const order: string[] = [];
    const { io: cio } = io();
    const deps: StagingTeardownDeps = {
      io: cio,
      runWranglerCommands: async (commands) => {
        order.push(`wrangler:${commands.length}`);
        return 0;
      },
      resolveBucketEmptier: async () => {
        order.push("resolve-creds");
        return {
          empty: async () => {
            order.push("empty-bucket");
          },
        };
      },
    };
    expect(await stagingTeardownCommand.run([], deps)).toBe(0);
    expect(order).toHaveLength(0);
    expect(await stagingTeardownCommand.run(["--execute"], deps)).toBe(0);
    expect(order[0]).toBe("resolve-creds");
    expect(order.at(-2)).toBe("empty-bucket");
    expect(order.at(-1)).toBe("wrangler:1");
  });

  it("teardown refuses to delete anything when the R2 credentials are missing", async () => {
    const order: string[] = [];
    const { io: cio } = io();
    const deps: StagingTeardownDeps = {
      io: cio,
      runWranglerCommands: async () => {
        order.push("wrangler");
        return 0;
      },
      resolveBucketEmptier: async () => {
        throw new Error("missing CORPUS_R2_ACCOUNT_ID");
      },
    };
    await expect(stagingTeardownCommand.run(["--execute"], deps)).rejects.toThrow("CORPUS_R2_ACCOUNT_ID");
    expect(order).toHaveLength(0);
  });
});

describe("ops staging smoke", () => {
  it("plan mode makes no requests and resolves no token", async () => {
    const { io: cio, out } = io();
    const deps: StagingSmokeDeps = {
      io: cio,
      fetch: (() => {
        throw new Error("no network in plan mode");
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      writeFile: async () => {
        throw new Error("no writes in plan mode");
      },
      resolveToken: () => {
        throw new Error("no token in plan mode");
      },
    };
    expect(await stagingSmokeCommand.run(["--provider", "openai"], deps)).toBe(0);
    expect(out.join("\n")).toContain("[PLAN] would run provider smoke");
  });

  it("requires --provider", async () => {
    const { io: cio } = io();
    const deps = stagingSmokeCommand.defaultDeps(cio);
    await expect(stagingSmokeCommand.run([], deps)).rejects.toThrow(UsageError);
  });

  it.each([
    "unauthorized",
    "submit raw_only",
    "import raw_only",
    "reprocess raw_only",
    "submit empty",
    "import empty",
    "reprocess empty",
    "submit missing",
  ])("rejects smoke with %s", async (scenario) => {
    const { io: cio } = io();
    let submittedReads = 0;
    let sleeps = 0;
    const stageFor = (id: string) =>
      id === "rd_import" ? "import" : submittedReads > 1 ? "reprocess" : "submit";
    const manifest = (id: string) => ({
      id,
      url: `https://example.test/${id}`,
      url_hash: "a".repeat(64),
      status: "ready",
      content_type: "text/html",
      content_status: scenario === `${stageFor(id)} raw_only` ? "raw_only" : "captured",
      content_bytes: 10,
      content_sha256: "b".repeat(64),
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:05:00.000Z",
      usage: {
        summarization: {
          provider: "openai",
          model: "gpt-test",
          input_tokens: 1,
          output_tokens: 1,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
        },
        openai_embedding_tokens: 1,
      },
    });
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/api/readings")) {
        return new Response(JSON.stringify({ id: "rd_submit", attempt_id: "at_submit" }), {
          status: 202,
        });
      }
      if (init?.method === "POST" && url.endsWith("/api/readings/import-markdown")) {
        return new Response(JSON.stringify({ id: "rd_import", attempt_id: "at_import" }), {
          status: 202,
        });
      }
      if (init?.method === "POST" && url.endsWith("/api/readings/rd_submit/reprocess")) {
        return new Response(JSON.stringify({ id: "rd_submit", attempt_id: "at_reprocess" }), {
          status: 202,
        });
      }
      if (url.endsWith("/content")) {
        const stage = url.includes("rd_import") ? "import" : submittedReads > 1 ? "reprocess" : "submit";
        return new Response(scenario === `${stage} empty` ? "  \n" : "# Extracted article", { status: scenario === "submit missing" ? 404 : 200 });
      }
      if (url.endsWith("/api/readings/rd_import")) {
        return new Response(JSON.stringify(manifest("rd_import")), { status: 200 });
      }
      if (url.endsWith("/api/readings/rd_submit")) {
        submittedReads += 1;
        if (submittedReads === 1) {
          return new Response(JSON.stringify(manifest("rd_submit")), { status: 200 });
        }
        if (scenario.startsWith("reprocess ")) {
          return Response.json({
            ...manifest("rd_submit"),
            updated_at: "2026-08-01T00:06:00.000Z",
            last_attempt: {
              id: "at_reprocess",
              trigger: "reprocess",
              status: "succeeded",
              started_at: "2026-08-01T00:05:00.000Z",
              finished_at: "2026-08-01T00:06:00.000Z",
            },
          });
        }
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const deps: StagingSmokeDeps = {
      io: cio,
      fetch: fetchMock,
      sleep: async () => {
        sleeps += 1;
      },
      now: () => Date.parse("2026-08-23T12:00:00Z"),
      writeFile: async () => {},
      resolveToken: () => "tok",
    };

    await expect(
      stagingSmokeCommand.run(["--provider", "openai", "--execute"], deps),
    ).rejects.toThrow(scenario === "unauthorized"
      ? "GET /api/readings/rd_submit: HTTP 401 unauthorized"
      : scenario.endsWith("raw_only") ? `${scenario.split(" ")[0]} expected captured article text, got raw_only`
      : scenario.endsWith("empty") ? `${scenario.split(" ")[0]} extracted article text was empty`
      : "submit extracted article request failed: HTTP 404");
    expect(sleeps).toBe(0);
    expect(submittedReads).toBe(scenario === "unauthorized" || scenario.startsWith("reprocess ") ? 2 : 1);
  });
});

describe("ops founder bootstrap", () => {
  function makeDeps() {
    const { io: cio, err } = io();
    const opened: string[] = [];
    const deps: FounderBootstrapCommandDeps = {
      io: cio,
      resolveEnvVars: () => ({
        FOUNDER_EMAIL: "founder@example.com",
        READER_API_TOKEN: "tok",
        AUTH_ROOT_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
      openDb: async (env) => {
        opened.push(env);
        return {
          first: async () => null,
          all: async () => [],
          batch: async () => {},
        } as never;
      },
      now: () => Date.parse("2026-08-22T12:00:00Z"),
    };
    return { deps, err, opened };
  }

  it("production execute without --confirm-production refuses with 2 before opening the db", async () => {
    const { deps, err, opened } = makeDeps();
    const code = await founderBootstrapCommand.run(["--env", "production", "--execute"], deps);
    expect(code).toBe(2);
    expect(opened).toHaveLength(0);
    expect(err.join("\n")).toContain("--confirm-production");
  });

  it("missing email is a usage failure (exit 2)", async () => {
    const { deps } = makeDeps();
    deps.resolveEnvVars = () => ({ READER_API_TOKEN: "tok", AUTH_ROOT_SECRET: "ab" });
    expect(await founderBootstrapCommand.run([], deps)).toBe(2);
  });

  it("rejects an unknown env as a usage error", async () => {
    const { deps } = makeDeps();
    await expect(founderBootstrapCommand.run(["--env", "qa"], deps)).rejects.toThrow(UsageError);
  });
});
