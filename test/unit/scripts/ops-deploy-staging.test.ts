import { describe, expect, it } from "vitest";
import { deployWorkerCommand, type DeployWorkerDeps } from "../../../scripts/ops-lib/commands/deploy-worker";
import { deployWebCommand, type DeployWebDeps } from "../../../scripts/ops-lib/commands/deploy-web";
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
  function makeDeps(
    migrate?: DeployWorkerDeps["migrateDatabase"],
  ) {
    const { io: cio, err } = io();
    const runs: string[][] = [];
    const migrated: { env: string; execute: boolean }[] = [];
    const deps: DeployWorkerDeps = {
      io: cio,
      validateTenantActivation: async () => ({ ok: true, message: "already enabled" }),
      // The PostgreSQL cutover guard has its own owner: test/unit/deploy/postgres-cutover.test.ts.
      checkPostgresCutover: () => ({ ok: true, bound: false }),
      runWrangler: async (args) => {
        runs.push(args);
        return 0;
      },
      migrateDatabase:
        migrate ??
        (async (databaseUrlEnv, execute) => {
          migrated.push({ env: databaseUrlEnv, execute });
          return { applied: [], pending: [] };
        }),
    };
    return { deps, err, runs, migrated };
  }

  describe("PostgreSQL migrations", () => {
    it("applies the target database's pending migrations before the upload", async () => {
      const order: string[] = [];
      const { deps, runs, err } = makeDeps(async (databaseUrlEnv, execute) => {
        order.push(`migrate:${databaseUrlEnv}:${execute}`);
        return { applied: ["0006_thing"], pending: [] };
      });
      const wrapped = deps.runWrangler;
      deps.runWrangler = async (args) => {
        order.push("upload");
        return wrapped(args);
      };
      expect(
        await deployWorkerCommand.run(
          ["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL", "--execute"],
          deps,
        ),
      ).toBe(0);
      // Schema before code: a Worker must never run against an older schema.
      expect(order).toEqual(["migrate:STAGING_DATABASE_URL:true", "upload"]);
      expect(runs).toHaveLength(1);
      expect(err.join("\n")).toContain("migrations applied");
    });

    it("plans migrations without applying them, and still dry-runs the deploy", async () => {
      const { deps, err, migrated, runs } = makeDeps();
      expect(await deployWorkerCommand.run(["--env", "staging"], deps)).toBe(0);
      expect(migrated).toEqual([{ env: "DATABASE_URL", execute: false }]);
      expect(runs[0]).toContain("--dry-run");
      expect(err.join("\n")).toContain("migrations");
    });

    // A deploy that cannot prove the schema is current must not ship code
    // that assumes it is — the same fail-closed rule as the wipe gate.
    it("refuses the upload when a migration fails", async () => {
      const { deps, runs, err } = makeDeps(async () => {
        throw new Error("REFUSED, drift: 0003_control_plane changed after it was applied");
      });
      expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL", "--execute"], deps)).toBe(2);
      expect(runs).toEqual([]);
      expect(err.join("\n")).toContain("drift");
    });

    // The staging Worker is deployed by hand, so --env staging with a
    // production string exported as DATABASE_URL would have applied this
    // repo's pending migrations to production.
    it("refuses when --env and --database-url-env name different environments", async () => {
      const { deps, runs, err, migrated } = makeDeps();
      expect(
        await deployWorkerCommand.run(
          ["--env", "staging", "--database-url-env", "NEON_MAIN_DATABASE_URL", "--execute"],
          deps,
        ),
      ).toBe(2);
      expect(runs).toEqual([]);
      expect(migrated).toEqual([]);
      expect(err.join("\n")).toContain("--env staging but NEON_MAIN_DATABASE_URL is the production database");
    });

    it("accepts a matching pair", async () => {
      const { deps, migrated } = makeDeps();
      expect(
        await deployWorkerCommand.run(
          ["--env", "staging", "--database-url-env", "NEON_REHEARSAL_DATABASE_URL", "--execute"],
          deps,
        ),
      ).toBe(0);
      expect(migrated).toEqual([{ env: "NEON_REHEARSAL_DATABASE_URL", execute: true }]);
    });

    // The first version of this guard only compared mapped names, so it was
    // inert on every real invocation: CI passes PRODUCTION_DATABASE_URL and
    // the default is DATABASE_URL, neither of which it knew.
    it("refuses an execute on a variable that names no deploy database", async () => {
      const { deps, runs, migrated, err } = makeDeps();
      expect(await deployWorkerCommand.run(["--env", "production", "--execute"], deps)).toBe(2);
      expect(runs).toEqual([]);
      expect(migrated).toEqual([]);
      expect(err.join("\n")).toContain("DATABASE_URL does not name a deploy database");
    });

    it("accepts the variable CI actually passes", async () => {
      const { deps, migrated } = makeDeps();
      expect(
        await deployWorkerCommand.run(
          ["--env", "production", "--database-url-env", "PRODUCTION_DATABASE_URL", "--execute"],
          deps,
        ),
      ).toBe(0);
      expect(migrated).toEqual([{ env: "PRODUCTION_DATABASE_URL", execute: true }]);
    });

    it("says in plan mode that execute would refuse", async () => {
      const { deps, err } = makeDeps(async () => {
        throw new Error("connection refused");
      });
      expect(await deployWorkerCommand.run(["--env", "staging"], deps)).toBe(0);
      expect(err.join("\n")).toContain("execute would refuse");
    });
  });

  it("tags an explicitly verified candidate and refuses an unverified checkout before writes", async () => {
    const sha = "a".repeat(40);
    const { deps, runs } = makeDeps();
    deps.validateCandidate = async candidate => { expect(candidate).toBe(sha); };
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL", "--release-sha", sha, "--execute"], deps)).toBe(0);
    expect(runs[0]).toEqual(["deploy", "--env", "staging", "--tag", sha]);
    runs.length = 0;
    deps.validateCandidate = async () => { throw new Error("dirty or mismatched checkout"); };
    await expect(deployWorkerCommand.run(["--database-url-env", "PRODUCTION_DATABASE_URL", "--release-sha", sha, "--execute"], deps)).rejects.toThrow("checkout");
    expect(runs).toEqual([]);
  });

  it("plan mode passes wrangler --dry-run and names the secrets the environment must hold", async () => {
    const { deps, err, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging"], deps)).toBe(0);
    expect(runs).toEqual([["deploy", "--env", "staging", "--dry-run"]]);
    expect(err.join("\n")).toContain("required runtime secret: AUTH_ROOT_SECRET");
    expect(err.join("\n")).toContain("bootstrap-only secret: READER_API_TOKEN");
  });

  it("--execute uploads without --dry-run", async () => {
    const { deps, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging", "--database-url-env", "STAGING_DATABASE_URL", "--execute"], deps)).toBe(0);
    expect(runs).toEqual([["deploy", "--env", "staging"]]);
  });

  it("rejects an invalid env", async () => {
    const { deps } = makeDeps();
    await expect(deployWorkerCommand.run(["--env", "dev"], deps)).rejects.toThrow(UsageError);
  });

  it("refuses unverified activation before the upload", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "off to on; 1 deletion-eligible tenant: usr_due" });
    expect(await deployWorkerCommand.run(["--database-url-env", "PRODUCTION_DATABASE_URL", "--execute"], deps)).toBe(2);
    expect(runs).toHaveLength(0);
    expect(err.join("\n")).toContain("usr_due");
    expect(err.join("\n")).toContain("--acknowledge-tenant-migration");
  });

  it("allows the explicit manual acknowledgement and logs it", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "unknown activation state" });
    expect(await deployWorkerCommand.run(["--database-url-env", "PRODUCTION_DATABASE_URL", "--execute", "--acknowledge-tenant-migration"], deps)).toBe(0);
    expect(runs.map(args => args[0])).toEqual(["deploy"]);
    expect(err.join("\n")).toContain("OVERRIDE");
  });

  it("does not inspect remote activation state in plan mode, even with acknowledgement", async () => {
    const { deps } = makeDeps();
    deps.validateTenantActivation = async () => { throw new Error("unexpected remote inspection"); };
    expect(await deployWorkerCommand.run(["--acknowledge-tenant-migration"], deps)).toBe(0);
  });
});

describe("ops deploy web", () => {
  function makeDeps() {
    const { io: cio, err } = io();
    const runs: { cmd: string; args: string[]; cwd?: string }[] = [];
    const deps: DeployWebDeps = {
      io: cio,
      runCmd: async (cmd, args, cwd) => {
        runs.push({ cmd, args, cwd });
        return 0;
      },
      summarizeDist: async () => ({ files: 3, bytes: 2048 }),
    };
    return { deps, err, runs };
  }

  it("plan mode neither builds nor uploads and leaves no build output", async () => {
    const { deps, err, runs } = makeDeps();
    expect(await deployWebCommand.run(["--branch", "staging"], deps)).toBe(0);
    expect(runs).toHaveLength(0);
    const text = err.join("\n");
    expect(text).toContain("would run: (cd web && npm run build)");
    expect(text).toContain("wrangler pages deploy dist --branch=staging");
  });

  it("--execute builds then uploads", async () => {
    const { deps, runs } = makeDeps();
    expect(await deployWebCommand.run(["--branch", "staging", "--execute"], deps)).toBe(0);
    expect(runs.map((r) => r.cmd)).toEqual(["npm", "wrangler"]);
    expect(runs[1].args).toContain("--branch=staging");
    expect(runs[1].cwd).toBe("web");
  });

  it("--execute --skip-build only uploads", async () => {
    const { deps, runs } = makeDeps();
    expect(await deployWebCommand.run(["--execute", "--skip-build"], deps)).toBe(0);
    expect(runs.map((r) => r.cmd)).toEqual(["wrangler"]);
  });

  it("a failing build stops the deploy", async () => {
    const { deps } = makeDeps();
    deps.runCmd = async (cmd) => (cmd === "npm" ? 1 : 0);
    expect(await deployWebCommand.run(["--execute"], deps)).toBe(1);
  });
});

describe("ops staging setup / teardown", () => {
  it("setup plans without running wrangler and executes with it", async () => {
    const runs: unknown[] = [];
    const { io: cio, err } = io();
    const deps: StagingSetupDeps = {
      io: cio,
      runWranglerCommands: async (commands) => {
        runs.push(commands);
        return 0;
      },
    };
    expect(await stagingSetupCommand.run([], deps)).toBe(0);
    expect(runs).toHaveLength(0);
    expect(err.join("\n")).toContain("wrangler");
    expect(await stagingSetupCommand.run(["--execute"], deps)).toBe(0);
    expect(runs).toHaveLength(1);
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
