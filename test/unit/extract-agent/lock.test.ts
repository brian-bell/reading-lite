import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireLock, type AcquireDeps, type LockFile } from "../../../scripts/extract-agent-lib/lock";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const HOST = "box";
const UPTIME_SECONDS = 7 * 24 * 60 * 60; // booted a week ago: nothing is pre-boot by accident

async function freshPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "extract-agent-lock-")), "nested", "extract-agent.lock");
}

function makeDeps(overrides: Partial<AcquireDeps> = {}): AcquireDeps & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    now: () => NOW,
    pid: 4242,
    host: HOST,
    runId: "run_1",
    uptimeSeconds: () => UPTIME_SECONDS,
    isProcessAlive: () => true,
    maxAgeSeconds: 3 * 60 * 60,
    warn,
    ...overrides,
    // `warn` is always the spy so assertions can read it, even when overridden.
    ...(overrides.warn ? {} : { warn }),
  } as AcquireDeps & { warn: ReturnType<typeof vi.fn> };
}

async function writeLockAt(path: string, lock: Partial<LockFile>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const full: LockFile = {
    v: 1,
    run_id: "run_other",
    pid: 999,
    host: HOST,
    started_at: NOW.toISOString(),
    ...lock,
  };
  await writeFile(path, `${JSON.stringify(full)}\n`, { encoding: "utf-8" });
}

async function readLock(path: string): Promise<LockFile> {
  return JSON.parse(await readFile(path, "utf-8")) as LockFile;
}

describe("acquireLock", () => {
  it("takes a free lock and records who holds it", async () => {
    const path = await freshPath();
    const deps = makeDeps();
    const result = await acquireLock(path, deps);

    expect(result.acquired).toBe(true);
    expect(await readLock(path)).toEqual({
      v: 1,
      run_id: "run_1",
      pid: 4242,
      host: HOST,
      started_at: NOW.toISOString(),
    });
    expect(deps.warn).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("refuses a lock held by a live process on this host, and leaves the file untouched", async () => {
    const path = await freshPath();
    await writeLockAt(path, { run_id: "run_other", pid: 999 });
    const before = await readFile(path, "utf-8");
    const deps = makeDeps({ isProcessAlive: () => true });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.holder).toMatchObject({ run_id: "run_other", pid: 999 });
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it("keeps refusing a live holder at any age — a visible stall beats an invisible double-spend", async () => {
    const path = await freshPath();
    await writeLockAt(path, { started_at: new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString() });
    const result = await acquireLock(path, makeDeps({ isProcessAlive: () => true, maxAgeSeconds: 3 * 60 * 60 }));

    expect(result.acquired).toBe(false);
  });

  it("breaks a lock whose holder is gone", async () => {
    const path = await freshPath();
    await writeLockAt(path, { run_id: "run_dead", pid: 999 });
    const deps = makeDeps({ isProcessAlive: () => false });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(true);
    expect((await readLock(path)).run_id).toBe("run_1");
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn.mock.calls[0]![0]).toMatch(/run_dead/);
  });

  it("breaks a lock written before the current boot, even though its pid looks alive (pid reuse)", async () => {
    const path = await freshPath();
    await writeLockAt(path, { started_at: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    const deps = makeDeps({ isProcessAlive: () => true });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(true);
    expect(deps.warn.mock.calls[0]![0]).toMatch(/boot/i);
  });

  it("respects a fresh lock from another host — liveness there is unknowable", async () => {
    const path = await freshPath();
    await writeLockAt(path, { host: "other-box", started_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const deps = makeDeps({ isProcessAlive: () => false });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(false);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("breaks a foreign-host lock past the age ceiling", async () => {
    const path = await freshPath();
    await writeLockAt(path, {
      host: "other-box",
      started_at: new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({ maxAgeSeconds: 3 * 60 * 60 });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(true);
    expect(deps.warn.mock.calls[0]![0]).toMatch(/other-box/);
  });

  it("respects a corrupt but freshly-modified lock, and says so", async () => {
    const path = await freshPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf-8");
    const deps = makeDeps();

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.holder).toBeUndefined();
    expect(deps.warn.mock.calls[0]![0]).toMatch(/unreadable|unparsable|corrupt/i);
  });

  it("hands a stale lock to exactly one of two contenders", async () => {
    // Both judge the same dead holder breakable at the same moment. Breaking has
    // to be a removal of the file they judged, not of whatever sits at the path
    // by the time they get there, or both would go on to spend paid actions.
    const path = await freshPath();
    await writeLockAt(path, { run_id: "run_dead", pid: 999 });
    const dead = makeDeps({ isProcessAlive: (pid) => pid !== 999 });

    const results = await Promise.all([
      acquireLock(path, { ...dead, runId: "run_a", pid: 111 }),
      acquireLock(path, { ...dead, runId: "run_b", pid: 222 }),
    ]);

    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    const winner = results.find((r) => r.acquired);
    expect((await readLock(path)).run_id).toBe(winner === results[0] ? "run_a" : "run_b");
  });

  it("treats a lock with an impossible pid as corrupt rather than eternally live", async () => {
    // `process.kill(0, 0)` signals our own process group and succeeds, so a
    // pid-0 lock would otherwise read as held forever.
    const path = await freshPath();
    await writeLockAt(path, { pid: 0, started_at: new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString() });
    const stale = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
    await utimes(path, stale, stale);

    const result = await acquireLock(path, makeDeps({ maxAgeSeconds: 3 * 60 * 60 }));
    expect(result.acquired).toBe(true);
    expect((await readLock(path)).run_id).toBe("run_1");
  });

  it("fails loudly on a lock that is present but unreadable, at any age", async () => {
    // A directory at the lock path stands in for the unreadable-but-present
    // cases (a root-written file the service user can't read, EIO). Silently
    // holding would strand every scheduled run in already_running with nothing
    // to show; reclaiming it would delete a lock whose holder may be alive. So
    // it fails the acquire, which the session turns into a reported crash.
    const path = await freshPath();
    await mkdir(path, { recursive: true });
    await expect(acquireLock(path, makeDeps())).rejects.toThrow();

    const stale = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
    await utimes(path, stale, stale);
    await expect(acquireLock(path, makeDeps({ maxAgeSeconds: 3 * 60 * 60 }))).rejects.toThrow();
  });

  it("breaks a corrupt lock once its mtime passes the age ceiling", async () => {
    const path = await freshPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf-8");
    const stale = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
    await utimes(path, stale, stale);
    const deps = makeDeps({ maxAgeSeconds: 3 * 60 * 60 });

    const result = await acquireLock(path, deps);
    expect(result.acquired).toBe(true);
    expect((await readLock(path)).run_id).toBe("run_1");
  });
});

describe("release", () => {
  it("removes our own lock", async () => {
    const path = await freshPath();
    const result = await acquireLock(path, makeDeps());
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await result.release();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is a silent no-op when the lock is already gone", async () => {
    const path = await freshPath();
    const deps = makeDeps();
    const result = await acquireLock(path, deps);
    if (!result.acquired) throw new Error("expected the lock");

    await result.release();
    await result.release();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("leaves a successor's lock alone and warns", async () => {
    const path = await freshPath();
    const deps = makeDeps();
    const result = await acquireLock(path, deps);
    if (!result.acquired) throw new Error("expected the lock");
    await writeLockAt(path, { run_id: "run_successor", pid: 5555 });

    await result.release();
    expect((await readLock(path)).run_id).toBe("run_successor");
    expect(deps.warn.mock.calls.at(-1)![0]).toMatch(/run_successor|another run/);
  });
});

