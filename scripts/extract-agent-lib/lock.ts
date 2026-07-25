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
// Same-boot pid reuse — a killed holder's pid handed to an unrelated long-lived
// process — reads as "held" forever, and that is accepted, not overlooked: it is
// the same trade as the first row. The run stops pinging, the dead-man pages,
// and the operator removes the file. Breaking it automatically would mean
// breaking live holders on a timer, which is the failure mode with no alarm.
//
// Residual race, stated rather than hidden: reclaiming a stale lock cannot be
// made a single atomic step against a *path* — POSIX has no compare-and-unlink,
// so every scheme trades one window for another (rename-and-verify leaves the
// path briefly empty if the reclaiming process is killed mid-flight;
// stat-then-unlink is crash-safe but can delete a lock that changed underneath
// it). This module takes the first trade: the removal below is a rename (one
// winner) plus an identity check, and an acquire re-reads the path before
// proceeding, which covers every two-contender interleaving. What remains
// needs a third contender, or a kill inside a sub-millisecond window during a
// reclaim, to let two runs believe they hold the lock.
//
// That residual is accepted for two reasons. This deployment is one timer plus
// the occasional manual run, so three simultaneous contenders is not a shape it
// has. And the lock is not the only thing standing between an overlap and a
// double charge: the Worker owns each URL, so the second submit of the same row
// returns an existing manifest, enqueues nothing, and hands its paid-action
// slot back (see `attemptRow` in run.ts). Closing the last window means a
// heartbeat protocol or a real advisory-lock dependency — the right move if
// this ever runs on more than one box, and not before.
//
// There is no signal handler in v1: SIGKILL/SIGTERM deliberately leaves the
// file behind, and the pid-liveness and boot rules are how it gets reclaimed.
// A handler would only cover SIGTERM, and the reclaim path has to exist anyway.

import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  await breakLock(path, existing, deps);
  // One retry only: losing this race means another run got there first, which
  // is exactly the situation the lock exists to produce.
  if (!(await tryCreate(path, deps))) return { acquired: false, holder: (await readLock(path)).lock };

  // Confirm the lock we just created is the one at the path. Breaking a stale
  // lock is the one moment several contenders can be mid-flight at once, and
  // this read is what stops us proceeding on a lock that a third one has
  // already replaced.
  const settled = await readLock(path);
  if (settled.lock?.run_id !== deps.runId) return { acquired: false, holder: settled.lock };
  return acquired(path, deps);
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
      // pid must be a real pid: `process.kill(0, 0)` signals our own process
      // group and always succeeds, so a `"pid": 0` lock would read as live
      // forever and stall every scheduled run. A file that says that is corrupt,
      // and the mtime path is how corrupt files get reclaimed.
      parsed.v !== 1 || typeof parsed.run_id !== "string" || !isPid(parsed.pid)
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

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

// Removing a lock — whether breaking a stale one or releasing our own — is a
// read-then-unlink, and read-then-unlink is a race: between the two, another
// contender can break the same file and put *its* live lock at that path, which
// we would then delete out from under it. So take the file out of play first
// with a rename (atomic: exactly one contender's rename can succeed) and decide
// afterwards, when the thing we are holding can no longer change underneath us.
// If what we moved turns out not to be what we judged, `link` it back — link
// refuses to clobber, so a lock created in the gap survives and we drop ours.
async function removeIfStillOurs(
  path: string,
  suffix: string,
  isOurs: (moved: ExistingLock) => boolean,
  onForeign?: (moved: ExistingLock) => void,
): Promise<void> {
  const scratch = `${path}.${suffix}`;
  try {
    await rename(path, scratch);
  } catch (e) {
    // Gone already: another contender got there first, which is a fine outcome
    // for both callers.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
  const moved = await readLock(scratch);
  if (!isOurs(moved)) {
    onForeign?.(moved);
    try {
      await link(scratch, path);
    } catch {
      // Someone claimed the path while we held their file aside. Their lock is
      // now unreachable by name, so keep the scratch copy rather than deleting
      // it: a stray `.breaking.*`/`.releasing.*` file an operator can see beats
      // destroying the only record of a run that still believes it holds the
      // lock. See the residual-race note in the module header.
      return;
    }
  }
  await unlink(scratch).catch(() => {});
}

async function breakLock(path: string, judged: ExistingLock, deps: AcquireDeps): Promise<void> {
  await removeIfStillOurs(path, `breaking.${deps.runId}`, (moved) => sameLock(moved, judged));
}

// Identity of the *file we judged*, not of a run: a corrupt lock has no run id,
// so its mtime is the only handle on "still the one I decided about".
function sameLock(a: ExistingLock, b: ExistingLock): boolean {
  if (a.lock && b.lock) {
    return a.lock.run_id === b.lock.run_id && a.lock.pid === b.lock.pid && a.lock.started_at === b.lock.started_at;
  }
  if (a.lock || b.lock) return false;
  return a.mtime?.getTime() === b.mtime?.getTime();
}

// Only ever removes our own lock: a run whose lock was legitimately broken must
// not delete its successor's.
async function release(path: string, deps: AcquireDeps): Promise<void> {
  await removeIfStillOurs(
    path,
    `releasing.${deps.runId}`,
    (moved) => moved.lock?.run_id === deps.runId,
    (moved) => {
      deps.warn(
        `not releasing lock at ${path}: it now belongs to another run (${moved.lock?.run_id ?? "unreadable"})`,
      );
    },
  );
}
