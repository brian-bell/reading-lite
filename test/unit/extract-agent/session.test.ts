import { mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ListIndexItem } from "../../../src/schemas/api";
import { AgentFatalError } from "../../../scripts/extract-agent-lib/poll";
import { appendRunLine, type RunLine } from "../../../scripts/extract-agent-lib/report";
import { runSession, type SessionDeps } from "../../../scripts/extract-agent-lib/session";
import type { LockFile } from "../../../scripts/extract-agent-lib/lock";
import { emptySidecar, type SidecarState } from "../../../scripts/extract-agent-lib/sidecar";
import type { ExtractOutcome } from "../../../scripts/extract-agent-lib/outcome";
import type { RedditOutcome } from "../../../scripts/extract-agent-lib/reddit";
import { makeConfig, makeRow } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const GOOD_MARKDOWN = "A serious article paragraph. ".repeat(20).trim();

function blockedRow(): ListIndexItem {
  return makeRow({
    status: "failed",
    error: { code: "BadStatusError", message: "bad response status 403: https://x", stage: "fetch_source" },
  });
}

async function freshLogPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "extract-agent-session-")), "runs.jsonl");
}

// A regular file standing in for a parent directory: every write under it fails
// with ENOTDIR, on every platform. (A directory is not portable here — on Linux
// the rotation rename would rename the directory itself and the append would
// then succeed.)
async function unwritableLogPath(): Promise<string> {
  const blocker = join(await mkdtemp(join(tmpdir(), "extract-agent-session-")), "not-a-directory");
  await writeFile(blocker, "", "utf-8");
  return join(blocker, "runs.jsonl");
}

async function freshLockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "extract-agent-session-lock-")), "extract-agent.lock");
}

async function writeHeldLock(path: string, lock: Partial<LockFile> = {}): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const full: LockFile = {
    v: 1,
    run_id: "run_other",
    pid: 999,
    host: "box",
    started_at: NOW.toISOString(),
    ...lock,
  };
  await writeFile(path, `${JSON.stringify(full)}\n`, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function makeDeps(
  overrides: Partial<SessionDeps> = {},
  configOverrides: Parameters<typeof makeConfig>[0] = {},
): Promise<{ deps: SessionDeps; fetchMock: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  const warn = vi.fn();
  const deps: SessionDeps = {
    config: makeConfig({ runLogPath: await freshLogPath(), lockPath: await freshLockPath(), ...configOverrides }),
    pageReadings: vi.fn(async () => [blockedRow()]),
    extract: vi.fn(
      async (): Promise<ExtractOutcome> => ({
        kind: "extracted",
        markdown: GOOD_MARKDOWN,
        title: "T",
        tier: "static", salvaged: false,
      }),
    ),
    reddit: vi.fn(
      async (): Promise<RedditOutcome> => ({
        kind: "extracted",
        body: { source_url: "https://www.reddit.com/r/x/comments/abc/t/", markdown: GOOD_MARKDOWN, title: "Reddit" },
      }),
    ),
    submit: vi.fn(async () => ({ outcome: "new" as const, id: "rd_x" })),
    loadState: vi.fn(async () => emptySidecar()),
    saveState: vi.fn(async (_state: SidecarState) => {}),
    now: () => NOW,
    log: () => {},
    fetch: fetchMock as unknown as typeof fetch,
    runId: "run_1",
    host: "box",
    pid: 4242,
    bootId: "boot_1",
    isProcessAlive: () => true,
    sleep: async () => {},
    writeRunLine: appendRunLine,
    warn,
    ...overrides,
  };
  return { deps, fetchMock, warn };
}

async function readLines(path: string): Promise<RunLine[]> {
  const raw = await readFile(path, "utf-8");
  return raw.trimEnd().split("\n").map((l) => JSON.parse(l) as RunLine);
}

describe("runSession", () => {
  it("persistReport:false leaves no run log, no report lock, and no ping (plan mode)", async () => {
    const { deps, fetchMock } = await makeDeps({ persistReport: false });
    const result = await runSession({ execute: false }, deps);

    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
    expect(result.summary?.dry_run).toBe(true);
    expect(await exists(deps.config.runLogPath)).toBe(false);
    expect(await exists(`${deps.config.runLogPath}.lock`)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("persistReport:false succeeds even when the run-log directory is unwritable", async () => {
    const blocker = join(await mkdtemp(join(tmpdir(), "extract-agent-session-")), "not-a-dir-file");
    await writeFile(blocker, "occupied", "utf-8");
    const { deps } = await makeDeps(
      { persistReport: false },
      { runLogPath: join(blocker, "runs.jsonl") },
    );
    const result = await runSession({ execute: false }, deps);
    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
  });

  it("reports and pings a completed execute run", async () => {
    const { deps, fetchMock } = await makeDeps({}, { healthcheckUrl: "https://hc.example/ping" });
    const result = await runSession({ execute: true }, deps);

    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
    expect(result.summary?.imported).toBe(1);
    const lines = await readLines(deps.config.runLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "ok", dry_run: false, run_id: "run_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hc.example/ping");
  });

  it("pings only after the report line is on disk", async () => {
    let linesWhenPinged: RunLine[] | undefined;
    const { deps } = await makeDeps({}, { healthcheckUrl: "https://hc.example/ping" });
    deps.fetch = (async () => {
      linesWhenPinged = await readLines(deps.config.runLogPath);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await runSession({ execute: true }, deps);
    expect(linesWhenPinged).toHaveLength(1);
  });

  it("still reports and pings a run that had nothing to do", async () => {
    const { deps, fetchMock } = await makeDeps(
      { pageReadings: vi.fn(async () => []) },
      { healthcheckUrl: "https://hc.example/ping" },
    );
    const result = await runSession({ execute: true }, deps);

    expect(result.exitCode).toBe(0);
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "ok", counts: { scanned: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never pings on a dry run — a manual dry run must not satisfy the dead-man window", async () => {
    const { deps, fetchMock } = await makeDeps({}, { healthcheckUrl: "https://hc.example/ping" });
    const result = await runSession({ execute: false }, deps);

    expect(result.exitCode).toBe(0);
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "ok", dry_run: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no request at all when no healthcheck url is configured", async () => {
    const { deps, fetchMock } = await makeDeps();
    const result = await runSession({ execute: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a crashed run, skips the success ping, and exits 1", async () => {
    const { deps, fetchMock, warn } = await makeDeps(
      {
        pageReadings: vi.fn(async () => {
          throw new AgentFatalError("GET /api/readings failed: 401");
        }),
      },
      { healthcheckUrl: "https://hc.example/ping" },
    );
    const result = await runSession({ execute: true }, deps);

    // The operator hears about a fatal run on stderr, not only in the JSONL log.
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/GET \/api\/readings failed: 401/);

    expect(result).toMatchObject({ status: "crashed", exitCode: 1 });
    expect(result.summary).toBeUndefined();
    const lines = await readLines(deps.config.runLogPath);
    expect(lines[0]).toMatchObject({
      status: "crashed",
      error: { name: "AgentFatalError", message: "GET /api/readings failed: 401" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pings the failure url on a crashed execute run when one is configured", async () => {
    const { deps, fetchMock } = await makeDeps(
      {
        pageReadings: vi.fn(async () => {
          throw new AgentFatalError("boom");
        }),
      },
      { healthcheckUrl: "https://hc.example/ping", healthcheckFailUrl: "https://hc.example/ping/fail" },
    );
    await runSession({ execute: true }, deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hc.example/ping/fail");
  });

  it("exits 1 on a crashed dry run without pinging anything", async () => {
    const { deps, fetchMock } = await makeDeps(
      {
        pageReadings: vi.fn(async () => {
          throw new AgentFatalError("boom");
        }),
      },
      { healthcheckUrl: "https://hc.example/ping", healthcheckFailUrl: "https://hc.example/ping/fail" },
    );
    const result = await runSession({ execute: false }, deps);

    expect(result).toMatchObject({ status: "crashed", exitCode: 1 });
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "crashed", dry_run: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the run when the report cannot be written, and pings nothing", async () => {
    const { deps, fetchMock, warn } = await makeDeps({}, {
      runLogPath: await unwritableLogPath(),
      healthcheckUrl: "https://hc.example/ping",
    });
    const result = await runSession({ execute: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("ok"); // the corpus work itself completed
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/run report/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a failed ping as a warning, not a failed run", async () => {
    const { deps, warn } = await makeDeps({}, { healthcheckUrl: "https://hc.example/ping" });
    deps.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND hc.example");
    }) as unknown as typeof fetch;

    const result = await runSession({ execute: true }, deps);
    expect(result.exitCode).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/ENOTFOUND/);
  });

  it("times the run with the injected clock", async () => {
    const times = [new Date("2026-07-15T12:00:00.000Z"), new Date("2026-07-15T12:00:07.000Z")];
    let calls = 0;
    const { deps } = await makeDeps({
      pageReadings: vi.fn(async () => []),
      now: () => times[Math.min(calls++, times.length - 1)]!,
    });
    await runSession({ execute: true }, deps);

    const line = (await readLines(deps.config.runLogPath))[0]!;
    expect(line.started_at).toBe("2026-07-15T12:00:00.000Z");
    expect(line.duration_ms).toBe(7000);
  });
});

describe("runSession concurrency", () => {
  it("holds the lock for the duration of an execute run and releases it at the end", async () => {
    let lockedDuringRun: boolean | undefined;
    const { deps } = await makeDeps();
    deps.pageReadings = vi.fn(async () => {
      lockedDuringRun = await exists(deps.config.lockPath);
      return [];
    });

    const result = await runSession({ execute: true }, deps);
    expect(lockedDuringRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(await exists(deps.config.lockPath)).toBe(false);
  });

  it("does no work at all when another live run holds the lock", async () => {
    const { deps, fetchMock } = await makeDeps({}, { healthcheckUrl: "https://hc.example/ping" });
    await writeHeldLock(deps.config.lockPath, { run_id: "run_other", pid: 999 });
    const before = await readFile(deps.config.lockPath, "utf-8");

    const result = await runSession({ execute: true }, deps);

    expect(result).toMatchObject({ status: "already_running", exitCode: 0 });
    expect(deps.pageReadings).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(deps.config.lockPath, "utf-8")).toBe(before);

    const line = (await readLines(deps.config.runLogPath))[0]!;
    expect(line).toMatchObject({
      status: "already_running",
      lock: { pid: 999, host: "box", started_at: NOW.toISOString() },
    });
    expect(line.counts).toBeUndefined();
  });

  it("rotates an oversized log from a yielded run under the report lock", async () => {
    const { deps } = await makeDeps({}, { runLogMaxBytes: 1024 });
    await writeHeldLock(deps.config.lockPath, { run_id: "run_other", pid: 999 });
    await writeFile(deps.config.runLogPath, `${"x".repeat(2000)}\n`, "utf-8");

    await runSession({ execute: true }, deps);

    expect(await readFile(`${deps.config.runLogPath}.1`, "utf-8")).toBe(`${"x".repeat(2000)}\n`);
    const lines = await readLines(deps.config.runLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "already_running" });
  });

  it("rotates an oversized log for dry runs instead of growing it without bound", async () => {
    const { deps } = await makeDeps({}, { runLogMaxBytes: 1024 });
    await writeFile(deps.config.runLogPath, `${"x".repeat(2000)}\n`, "utf-8");

    await runSession({ execute: false }, deps);

    expect(await readFile(`${deps.config.runLogPath}.1`, "utf-8")).toBe(`${"x".repeat(2000)}\n`);
    const lines = await readLines(deps.config.runLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "ok", dry_run: true });
  });

  it("waits for the report lock before an execute run rotates and appends", async () => {
    const { deps } = await makeDeps({}, { runLogMaxBytes: 1024 });
    const reportLockPath = `${deps.config.runLogPath}.lock`;
    await writeHeldLock(reportLockPath, { run_id: "run_other_report", pid: 999 });
    await writeFile(deps.config.runLogPath, `${"x".repeat(2000)}\n`, "utf-8");
    const sleep = vi.fn(async () => {
      expect(await exists(`${deps.config.runLogPath}.1`)).toBe(false);
      await unlink(reportLockPath);
    });
    deps.sleep = sleep;

    await runSession({ execute: true }, deps);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(await readFile(`${deps.config.runLogPath}.1`, "utf-8")).toBe(`${"x".repeat(2000)}\n`);
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "ok", dry_run: false });
  });

  it("reclaims a report lock past its short ceiling even when the pid looks alive", async () => {
    const { deps, warn } = await makeDeps();
    const reportLockPath = `${deps.config.runLogPath}.lock`;
    await writeHeldLock(reportLockPath, {
      run_id: "run_stale_report",
      pid: 999,
      started_at: new Date(NOW.getTime() - 31_000).toISOString(),
    });

    const result = await runSession({ execute: false }, deps);

    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "ok", dry_run: true });
    expect(warn.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/run_stale_report/);
  });

  it("records and pings a failed execute run when the report lock cannot be released", async () => {
    let writes = 0;
    const { deps, fetchMock, warn } = await makeDeps(
      {
        writeRunLine: async (path, line, opts) => {
          await appendRunLine(path, line, opts);
          writes += 1;
          if (writes === 1) {
            await rename(`${path}.lock`, `${path}.lock.held`);
            await mkdir(`${path}.lock`);
          }
        },
      },
      { healthcheckUrl: "https://hc.example/ping", healthcheckFailUrl: "https://hc.example/ping/fail" },
    );

    const result = await runSession({ execute: true }, deps);

    expect(result).toMatchObject({ status: "crashed", exitCode: 1 });
    expect((await readLines(deps.config.runLogPath)).map((line) => line.status)).toEqual(["ok", "crashed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hc.example/ping/fail");
    expect(warn.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/release the report lock/);
  });

  it("reports a lock that cannot be acquired at all as a crashed run", async () => {
    // An unwritable lock path (bad mount, wrong owner) must not bypass the run
    // report and the failure ping on its way to stderr.
    const { deps, fetchMock } = await makeDeps({}, {
      lockPath: await unwritableLogPath(),
      healthcheckUrl: "https://hc.example/ping",
      healthcheckFailUrl: "https://hc.example/ping/fail",
    });
    const result = await runSession({ execute: true }, deps);

    expect(result).toMatchObject({ status: "crashed", exitCode: 1 });
    expect(deps.pageReadings).not.toHaveBeenCalled();
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "crashed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hc.example/ping/fail");
  });

  it("releases the lock even when the run crashes", async () => {
    const { deps } = await makeDeps({
      pageReadings: vi.fn(async () => {
        throw new AgentFatalError("boom");
      }),
    });
    const result = await runSession({ execute: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(await exists(deps.config.lockPath)).toBe(false);
  });

  it("releases the lock even when the report cannot be written", async () => {
    const { deps } = await makeDeps({}, { runLogPath: await unwritableLogPath() });
    const result = await runSession({ execute: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(await exists(deps.config.lockPath)).toBe(false);
  });

  it("reports a failed lock release as crashed and pings the failure url", async () => {
    const { deps, fetchMock, warn } = await makeDeps(
      {
        pageReadings: vi.fn(async () => {
          // Replacing our file with a directory makes the release's safe
          // rename-and-restore path fail without depending on Unix permissions.
          await rename(deps.config.lockPath, `${deps.config.lockPath}.held`);
          await mkdir(deps.config.lockPath);
          return [];
        }),
      },
      { healthcheckUrl: "https://hc.example/ping", healthcheckFailUrl: "https://hc.example/ping/fail" },
    );

    const result = await runSession({ execute: true }, deps);

    expect(result).toMatchObject({ status: "crashed", exitCode: 1 });
    expect((await readLines(deps.config.runLogPath))[0]).toMatchObject({ status: "crashed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hc.example/ping/fail");
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/release.*lock/i);
  });

  it("never takes the lock on a dry run, but warns when an execute run is in flight", async () => {
    const { deps, warn } = await makeDeps();
    await writeHeldLock(deps.config.lockPath, { run_id: "run_other", pid: 999 });
    const before = await readFile(deps.config.lockPath, "utf-8");

    const result = await runSession({ execute: false }, deps);

    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
    expect(deps.pageReadings).toHaveBeenCalled();
    expect(await readFile(deps.config.lockPath, "utf-8")).toBe(before);
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/run_other|already running/);
  });

  it("leaves no lock behind on a dry run with a free lock", async () => {
    const { deps, warn } = await makeDeps();
    await runSession({ execute: false }, deps);

    expect(await exists(deps.config.lockPath)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
