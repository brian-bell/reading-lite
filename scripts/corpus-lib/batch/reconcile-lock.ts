import { writeFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

// Single-process exclusion lock for OpenAI batch reconciliation.
//
// What it protects: the list-then-create window in `openai-reconcile.ts` is
// not atomic at the OpenAI Batch API (no idempotency key). Two concurrent
// resumes of the same sidecar could both observe an empty listing and
// both call `create`, double-billing. `--sole-writer` is the operator
// contract at the CLI layer; this lock is the local-process enforcement.
//
// Design: a `<sidecar>.lock` file created with `wx` (O_EXCL) is the mutual
// exclusion, not a check-then-act. A stale lock older than `maxAgeSeconds`
// is broken once. The acquire re-reads the path before returning, so a
// reclaim that lost to a third contender is caught.
//
// Residual: a kill between the wx create and the identity-check re-read
// can leave two contending processes both believing they hold the lock.
// Closing that window requires a heartbeat protocol — overkill for an
// operator-driven batch tool. The lock is sufficient because (a) only one
// human runs `corpus-ingest --execute` / `corpus-recover --batch --execute`
// at a time, and (b) `--sole-writer` is enforced upstream.

const LOCK_TTL_SECONDS = 60 * 30; // 30 minutes: longer than any plausible batch window.

export interface ReconcileLock {
  release(): Promise<void>;
}

interface LockRecord {
  pid: number;
  host: string;
  started_at: string;
}

export async function acquireReconcileLock(
  sidecarPath: string,
  deps: { now?: () => Date; pid?: number; host?: string } = {},
): Promise<ReconcileLock> {
  const now = deps.now ?? (() => new Date());
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? os_hostname();
  const lockPath = sidecarPath + ".lock";
  const record: LockRecord = {
    pid,
    host,
    started_at: now().toISOString(),
  };
  const payload = `${JSON.stringify(record)}\n`;

  // Try once. If a stale lock exists, break it; if the file is held by a
  // live process, refuse.
  const created = await tryCreate(lockPath, payload);
  if (created) {
    return confirm(lockPath, record, now);
  }

  const existing = await readLock(lockPath);
  if (!existing.lock) {
    // Vanished between our failed create and the read — retry once.
    if (await tryCreate(lockPath, payload)) {
      return confirm(lockPath, record, now);
    }
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} is contested; refusing to create`,
    );
  }
  if (!isStale(existing.lock, existing.mtime, now())) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} is held by pid ${existing.lock.pid} on ${existing.lock.host} ` +
        `since ${existing.lock.started_at}; another batch process is already running. ` +
        `Pass --sole-writer and wait for it to finish, or remove the lock file if it is stale.`,
    );
  }
  // Stale lock — break it by renaming then re-trying. Renaming is one winner;
  // we re-read after our create to confirm our lock is the one at the path.
  await rename(lockPath, `${lockPath}.broken.${pid}.${Date.now()}`);
  if (!(await tryCreate(lockPath, payload))) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} was stale but a concurrent reclaim won; refusing to create`,
    );
  }
  return confirm(lockPath, record, now);
}

async function tryCreate(path: string, payload: string): Promise<boolean> {
  try {
    await writeFile(path, payload, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

async function readLock(path: string): Promise<{
  lock?: LockRecord;
  mtime?: Date;
}> {
  let mtime: Date | undefined;
  try {
    mtime = (await stat(path)).mtime;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
  try {
    const raw = (await readFile(path, "utf-8")).trim();
    return { lock: JSON.parse(raw) as LockRecord, mtime };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return { mtime }; // unparsable but present — treat as stale
  }
}

function isStale(lock: LockRecord | undefined, mtime: Date | undefined, now: Date): boolean {
  if (!lock) return true;
  if (!mtime) return true;
  const ageMs = now.getTime() - mtime.getTime();
  return ageMs > LOCK_TTL_SECONDS * 1000;
}

async function confirm(
  lockPath: string,
  expected: LockRecord,
  _now: () => Date,
): Promise<ReconcileLock> {
  // Read-back identity check: stops us proceeding on a lock that a
  // concurrent reclaim has already replaced.
  const settled = await readLock(lockPath);
  if (
    !settled.lock ||
    settled.lock.pid !== expected.pid ||
    settled.lock.started_at !== expected.started_at
  ) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} was reclaimed by another process; refusing to proceed`,
    );
  }
  return {
    async release() {
      // Best-effort unlink; missing is fine (TTL reclaim handles it).
      try {
        await unlink(lockPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
      }
    },
  };
}

function os_hostname(): string {
  try {
    return require("node:os").hostname();
  } catch {
    return "unknown";
  }
}

// Re-export path helpers for callers that want the lock file path.
export function reconcileLockPath(sidecarPath: string): string {
  return sidecarPath + ".lock";
}

// Suppress the unused-import warning for `join` / `basename` / `dirname` when
// the file shrinks; keep them in case future helpers derive paths.
void dirname;
void join;
void basename;