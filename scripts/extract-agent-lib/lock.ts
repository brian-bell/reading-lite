// Single-writer lockfile for a timer-driven run.
//
// What it protects: two overlapping runs plan from the same corpus listing and
// would submit the same rows twice — paid work, and a last-writer-wins race on
// the attempt sidecar. A skipped cycle costs nothing (the next timer tick picks
// the rows up); a double-spend cannot be undone. Everything below biases that
// way.
//
// The staleness table, and why:
//
//   | lock state                                       | verdict          |
//   |--------------------------------------------------|------------------|
//   | same host, pid alive                              | held (any age)   |
//   | same host, started_at before this boot            | break + warn     |
//   | same host, pid dead                               | break + warn     |
//   | foreign host, age <= maxAgeSeconds                | held             |
//   | foreign host, age > maxAgeSeconds                 | break + warn     |
//   | unparsable, mtime age <= maxAgeSeconds            | held + warn      |
//   | unparsable, mtime age > maxAgeSeconds             | break + warn     |
//
// The contestable row is the first one: a live holder is never broken, at any
// age. Age-based breaking of a *live* holder trades an observable stall for an
// unobserved double-spend — a wedged run stops pinging, so the dead-man pages
// the operator, who clears it by hand. So the age ceiling applies only where
// liveness is unknowable: a foreign hostname or a corrupt file. The one case
// where liveness *lies* — reboot with pid reuse — is caught by the boot rule,
// which is checked before liveness, not by age.
//
// There is no signal handler in v1: SIGKILL/SIGTERM deliberately leaves the
// file behind, and the pid-liveness and boot rules are how it gets reclaimed.
// A handler would only cover SIGTERM, and the reclaim path has to exist anyway.

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockFile {
  v: 1;
  run_id: string;
  pid: number;
  host: string;
  started_at: string;
}

export interface AcquireDeps {
  now: () => Date;
  pid: number;
  host: string;
  runId: string;
  uptimeSeconds: () => number;
  isProcessAlive: (pid: number) => boolean;
  maxAgeSeconds: number;
  warn: (message: string) => void;
}

export type AcquireResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; holder?: LockFile };

export async function acquireLock(path: string, deps: AcquireDeps): Promise<AcquireResult> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await tryCreate(path, deps)) return acquired(path, deps);

  const existing = await readLock(path);
  const verdict = await judge(path, existing, deps);
  if (verdict.hold) {
    if (verdict.why) deps.warn(verdict.why);
    return { acquired: false, holder: existing.lock };
  }

  deps.warn(verdict.why!);
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  // One retry only: losing this race means another run got there first, which
  // is exactly the situation the lock exists to produce.
  if (await tryCreate(path, deps)) return acquired(path, deps);
  return { acquired: false, holder: (await readLock(path)).lock };
}

// Read-only peek, for a dry run that wants to say "an execute run is in flight"
// without taking or judging the lock.
export async function readLockHolder(path: string): Promise<LockFile | undefined> {
  return (await readLock(path)).lock;
}

function acquired(path: string, deps: AcquireDeps): AcquireResult {
  return { acquired: true, release: () => release(path, deps) };
}

async function tryCreate(path: string, deps: AcquireDeps): Promise<boolean> {
  const lock: LockFile = {
    v: 1,
    run_id: deps.runId,
    pid: deps.pid,
    host: deps.host,
    started_at: deps.now().toISOString(),
  };
  try {
    // "wx" is O_EXCL: the create is the mutual exclusion, not a check-then-act.
    await writeFile(path, `${JSON.stringify(lock)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

interface ExistingLock {
  lock?: LockFile;
  mtime?: Date;
}

async function readLock(path: string): Promise<ExistingLock> {
  let raw: string;
  let mtime: Date | undefined;
  try {
    raw = await readFile(path, "utf-8");
    mtime = (await stat(path)).mtime;
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockFile>;
    if (
      parsed.v !== 1 || typeof parsed.run_id !== "string" || typeof parsed.pid !== "number"
      || typeof parsed.host !== "string" || typeof parsed.started_at !== "string"
      || Number.isNaN(Date.parse(parsed.started_at))
    ) {
      return { mtime };
    }
    return { lock: parsed as LockFile, mtime };
  } catch {
    return { mtime };
  }
}

async function judge(
  path: string,
  existing: ExistingLock,
  deps: AcquireDeps,
): Promise<{ hold: boolean; why?: string }> {
  const now = deps.now().getTime();
  const { lock } = existing;

  if (!lock) {
    // Vanished between the failed create and the read: treat it as contended
    // rather than assuming it is ours to take.
    if (!existing.mtime) return { hold: true };
    const ageSeconds = (now - existing.mtime.getTime()) / 1000;
    if (ageSeconds <= deps.maxAgeSeconds) {
      return { hold: true, why: `lock at ${path} is unreadable; holding off (last modified ${existing.mtime.toISOString()})` };
    }
    return { hold: false, why: `breaking unreadable lock at ${path}, last modified ${existing.mtime.toISOString()}` };
  }

  const startedAt = Date.parse(lock.started_at);
  if (lock.host === deps.host) {
    const bootTime = now - deps.uptimeSeconds() * 1000;
    if (startedAt < bootTime) {
      // Predates this boot, so its pid — alive or not — belongs to some other
      // process now. This is the only case where liveness lies.
      return { hold: false, why: `breaking lock from run ${lock.run_id} (pid ${lock.pid}): written before the current boot` };
    }
    if (deps.isProcessAlive(lock.pid)) return { hold: true };
    return { hold: false, why: `breaking lock from run ${lock.run_id}: pid ${lock.pid} is gone` };
  }

  const ageSeconds = (now - startedAt) / 1000;
  if (ageSeconds <= deps.maxAgeSeconds) return { hold: true };
  return {
    hold: false,
    why: `breaking lock from run ${lock.run_id} on ${lock.host}: ${Math.round(ageSeconds)}s old, past the ${deps.maxAgeSeconds}s ceiling`,
  };
}

// Only ever removes our own lock: a run whose lock was legitimately broken must
// not delete its successor's.
async function release(path: string, deps: AcquireDeps): Promise<void> {
  const { lock } = await readLock(path);
  if (!lock) return;
  if (lock.run_id !== deps.runId) {
    deps.warn(`not releasing lock at ${path}: it now belongs to another run (${lock.run_id})`);
    return;
  }
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
}
