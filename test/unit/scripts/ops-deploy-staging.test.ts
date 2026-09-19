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
  function makeDeps(ok = true) {
    const { io: cio, err } = io();
    const runs: string[][] = [];
    const deps: DeployWorkerDeps = {
      io: cio,
      validateTenantActivation: async () => ({ ok: true, message: "already enabled" }),
      // The PostgreSQL cutover guard has its own owner: test/unit/deploy/postgres-cutover.test.ts.
      checkPostgresCutover: () => ({ ok: true, bound: false }),
      runWrangler: async (args) => {
        runs.push(args);
        return 0;
      },
      validateReadiness: () => ({
        ok,
        ...(ok
          ? {
              d1: {
                binding: "CONTROL_PLANE",
                databaseName: "reading-lite-control-staging",
                databaseId: "real-id",
              },
            }
          : { error: "placeholder database_id" }),
        requiredSecrets: { runtime: ["AUTH_ROOT_SECRET", "OPENAI_API_KEY"], bootstrapOnly: ["READER_API_TOKEN"] },
      }) as never,
    };
    return { deps, err, runs };
  }

  it("tags an explicitly verified candidate and refuses an unverified checkout before writes", async () => {
    const sha = "a".repeat(40);
    const { deps, runs } = makeDeps();
    deps.validateCandidate = async candidate => { expect(candidate).toBe(sha); };
    expect(await deployWorkerCommand.run(["--env", "staging", "--release-sha", sha, "--execute"], deps)).toBe(0);
    expect(runs[1]).toEqual(["deploy", "--env", "staging", "--tag", sha]);
    runs.length = 0;
    deps.validateCandidate = async () => { throw new Error("dirty or mismatched checkout"); };
    await expect(deployWorkerCommand.run(["--release-sha", sha, "--execute"], deps)).rejects.toThrow("checkout");
    expect(runs).toEqual([]);
  });

  it("plan mode prints the remote D1 migrate command and passes wrangler --dry-run", async () => {
    const { deps, err, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging"], deps)).toBe(0);
    expect(runs).toEqual([["deploy", "--env", "staging", "--dry-run"]]);
    expect(err.join("\n")).toContain(
      "wrangler d1 migrations apply reading-lite-control-staging --env staging --remote",
    );
  });

  it("--execute applies remote D1 migrations then uploads without --dry-run", async () => {
    const { deps, runs } = makeDeps();
    expect(await deployWorkerCommand.run(["--env", "staging", "--execute"], deps)).toBe(0);
    expect(runs).toEqual([
      ["d1", "migrations", "apply", "reading-lite-control-staging", "--env", "staging", "--remote"],
      ["deploy", "--env", "staging"],
    ]);
  });

  it("a failed migrate does not upload the Worker", async () => {
    const { deps, runs } = makeDeps();
    deps.runWrangler = async (args) => {
      runs.push(args);
      return args[0] === "d1" ? 1 : 0;
    };
    expect(await deployWorkerCommand.run(["--env", "staging", "--execute"], deps)).toBe(1);
    expect(runs).toEqual([
      ["d1", "migrations", "apply", "reading-lite-control-staging", "--env", "staging", "--remote"],
    ]);
  });

  it("a failed control-plane preflight blocks execute but only warns a plan", async () => {
    const failing = makeDeps(false);
    expect(await deployWorkerCommand.run(["--execute"], failing.deps)).toBe(2);
    expect(failing.runs).toHaveLength(0);
    const planning = makeDeps(false);
    expect(await deployWorkerCommand.run([], planning.deps)).toBe(0);
    expect(planning.runs).toHaveLength(1);
  });

  it("rejects an invalid env", async () => {
    const { deps } = makeDeps();
    await expect(deployWorkerCommand.run(["--env", "dev"], deps)).rejects.toThrow(UsageError);
  });

  it("refuses unverified activation before any migration or upload", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "off to on; 1 deletion-eligible tenant: usr_due" });
    expect(await deployWorkerCommand.run(["--execute"], deps)).toBe(2);
    expect(runs).toHaveLength(0);
    expect(err.join("\n")).toContain("usr_due");
    expect(err.join("\n")).toContain("--acknowledge-tenant-migration");
  });

  it("allows the explicit manual acknowledgement and logs it", async () => {
    const { deps, runs, err } = makeDeps();
    deps.validateTenantActivation = async () => ({ ok: false, message: "unknown activation state" });
    expect(await deployWorkerCommand.run(["--execute", "--acknowledge-tenant-migration"], deps)).toBe(0);
    expect(runs.map(args => args[0])).toEqual(["d1", "deploy"]);
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
