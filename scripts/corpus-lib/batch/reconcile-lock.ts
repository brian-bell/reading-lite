import { writeFile, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname as osHostname } from "node:os";

// Single-process exclusion lock for OpenAI batch reconciliation.
//
// What it protects: the list-then-create window in `openai-reconcile.ts` is
// not atomic at the OpenAI Batch API (no idempotency key). Two concurrent
// resumes of the same sidecar could both observe an empty listing and
// both call `create`, double-billing. `--sole-writer` is the operator
// contract at the CLI layer; this lock is the local-process enforcement.
//
// Design: a `<sidecar>.lock` file created with `wx` (O_EXCL) is the mutual
// exclusion, not a check-then-act. A same-host lock whose pid is still
// alive is never aged out — a 200 MB upload can outlive the TTL. Age
// applies only when liveness is unknowable (foreign host) or the pid is
// gone. A background heartbeat refreshes mtime for the hold lifetime;
// `heartbeat()` also re-reads identity so a holder that lost a reclaim
// cannot keep uploading.
//
// Stale-lock reclaim is serialized by an exclusive `<lock>.reclaim` file
// (`wx`) plus a re-read of the stale identity under that gate. Residual:
// a kill between the wx create and the identity-check re-read can still
// leave two holders; closing that needs a kernel advisory lock. The file
// lock plus `--sole-writer` is the operator-tool bound.

const LOCK_TTL_SECONDS = 60 * 30; // 30 minutes: foreign-host / dead-pid ceiling.

export interface ReconcileLock {
  release(): Promise<void>;
  heartbeat?(): Promise<void>;
}

interface LockRecord {
  pid: number;
  host: string;
  started_at: string;
}

export async function acquireReconcileLock(
  sidecarPath: string,
  deps: {
    now?: () => Date;
    pid?: number;
    host?: string;
    isProcessAlive?: (pid: number) => boolean;
    // 0 disables the background refresh. Default 60s keeps foreign-host
    // TTL from aging out a holder mid-upload.
    heartbeatIntervalMs?: number;
  } = {},
): Promise<ReconcileLock> {
  const now = deps.now ?? (() => new Date());
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? osHostname();
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 60_000;
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
    return confirm(lockPath, record, heartbeatIntervalMs);
  }

  const existing = await readLock(lockPath);
  // Three cases for "lock file present but no parsed record":
  //   a) File vanished between our failed create and the read → retry.
  //   b) File is partially written (a process was killed mid-write) or
  //      unparsable → treat as stale and reclaim.
  //   c) Both `lock` and `mtime` missing means the file was never there
  //      at read time (truly vanished). Only this case retries.
  if (!existing.lock && !existing.mtime) {
    if (await tryCreate(lockPath, payload)) {
      return confirm(lockPath, record, heartbeatIntervalMs);
    }
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} is contested; refusing to create`,
    );
  }
  if (!existing.lock) {
    // Partially written / corrupt lock — recover through the stale-lock path.
    return reclaimStaleLock(
      lockPath,
      payload,
      record,
      pid,
      heartbeatIntervalMs,
      { now, host, isProcessAlive },
    );
  }
  if (!isStale(existing.lock, existing.mtime, now(), { host, isProcessAlive })) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} is held by pid ${existing.lock.pid} on ${existing.lock.host} ` +
        `since ${existing.lock.started_at}; another batch process is already running. ` +
        `Pass --sole-writer and wait for it to finish, or remove the lock file if it is stale.`,
    );
  }
  return reclaimStaleLock(
    lockPath,
    payload,
    record,
    pid,
    heartbeatIntervalMs,
    { now, host, isProcessAlive },
    existing.lock,
  );
}

async function reclaimStaleLock(
  lockPath: string,
  payload: string,
  record: LockRecord,
  pid: number,
  heartbeatIntervalMs: number,
  liveness: { now: () => Date; host: string; isProcessAlive: (pid: number) => boolean },
  expectedStale?: LockRecord,
): Promise<ReconcileLock> {
  return withReclaimGate(lockPath, pid, liveness, async () => {
  // Re-read under the exclusive reclaim gate so a concurrent reclaim cannot
  // rename a live lock that we installed after the earlier stale check.
  const again = await readLock(lockPath);
  if (expectedStale) {
    if (!sameHolder(again.lock, expectedStale)) {
      throw new Error(
        `OpenAI reconcile lock at ${lockPath} changed before reclaim; refusing to create`,
      );
    }
    if (!isStale(again.lock, again.mtime, liveness.now(), liveness)) {
      throw new Error(
        `OpenAI reconcile lock at ${lockPath} is held by pid ${again.lock!.pid} on ${again.lock!.host} ` +
          `since ${again.lock!.started_at}; another batch process is already running. ` +
          `Pass --sole-writer and wait for it to finish, or remove the lock file if it is stale.`,
      );
    }
  } else if (again.lock || !again.mtime) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} changed before reclaim; refusing to create`,
    );
  }
  try {
    await rename(lockPath, `${lockPath}.broken.${pid}.${Date.now()}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `OpenAI reconcile lock at ${lockPath} was stale but a concurrent reclaim won; refusing to create`,
      );
    }
    throw e;
  }
  if (!(await tryCreate(lockPath, payload))) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} was stale but a concurrent reclaim won; refusing to create`,
    );
  }
  return confirm(lockPath, record, heartbeatIntervalMs);
  });
}

async function withReclaimGate<T>(
  lockPath: string,
  pid: number,
  liveness: { now: () => Date; host: string; isProcessAlive: (pid: number) => boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const gate = `${lockPath}.reclaim`;
  const record = { pid, host: liveness.host };
  if (!(await tryCreate(gate, `${JSON.stringify(record)}\n`))) {
    await takeAbandonedReclaimGate(gate, pid, liveness);
    if (!(await tryCreate(gate, `${JSON.stringify(record)}\n`))) {
      throw new Error(
        `OpenAI reconcile lock at ${lockPath} is already being reclaimed; refusing to create`,
      );
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const existing = await readReclaimHolder(gate);
      if (
        existing.holder &&
        existing.holder.pid === pid &&
        existing.holder.host === liveness.host
      ) {
        await unlink(gate);
      }
    } catch {
      // Gate already gone or not ours.
    }
  }
}

async function takeAbandonedReclaimGate(
  gate: string,
  pid: number,
  liveness: { now: () => Date; host: string; isProcessAlive: (pid: number) => boolean },
): Promise<void> {
  const existing = await readReclaimHolder(gate);
  const abandoned =
    !existing.holder ||
    (existing.holder.host === liveness.host &&
      !liveness.isProcessAlive(existing.holder.pid)) ||
    (existing.holder.host !== liveness.host &&
      existing.mtime !== undefined &&
      liveness.now().getTime() - existing.mtime.getTime() >
        LOCK_TTL_SECONDS * 1000);
  if (!abandoned) {
    throw new Error(
      `OpenAI reconcile lock reclaim gate at ${gate} is already being reclaimed; refusing to create`,
    );
  }
  try {
    await rename(gate, `${gate}.broken.${pid}.${Date.now()}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `OpenAI reconcile lock reclaim gate at ${gate} is already being reclaimed; refusing to create`,
      );
    }
    throw e;
  }
}

async function readReclaimHolder(
  gate: string,
): Promise<{ holder?: { pid: number; host: string }; mtime?: Date }> {
  let mtime: Date | undefined;
  try {
    mtime = (await stat(gate)).mtime;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
  try {
    const parsed = JSON.parse((await readFile(gate, "utf-8")).trim()) as {
      pid?: unknown;
      host?: unknown;
    };
    if (
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.host === "string" &&
      parsed.host.length > 0
    ) {
      return { holder: { pid: parsed.pid, host: parsed.host }, mtime };
    }
    return { mtime };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return { mtime };
  }
}

void stat;

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

function isStale(
  lock: LockRecord | undefined,
  mtime: Date | undefined,
  now: Date,
  self: { host: string; isProcessAlive: (pid: number) => boolean },
): boolean {
  if (!lock) return true;
  if (!mtime) return true;
  // A still-running same-host holder is never stale: upload/list can outlive
  // the TTL. Age only applies when we cannot ask the holder (foreign host)
  // or when the pid is already gone.
  if (lock.host === self.host && self.isProcessAlive(lock.pid)) return false;
  const ageMs = now.getTime() - mtime.getTime();
  return ageMs > LOCK_TTL_SECONDS * 1000;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sameHolder(lock: LockRecord | undefined, expected: LockRecord): boolean {
  return Boolean(
    lock && lock.pid === expected.pid && lock.started_at === expected.started_at,
  );
}

async function refreshLock(lockPath: string, expected: LockRecord): Promise<void> {
  const settledNow = await readLock(lockPath);
  if (!sameHolder(settledNow.lock, expected)) {
    throw new Error(
      `OpenAI reconcile lock at ${lockPath} was reclaimed by another process; refusing to proceed`,
    );
  }
  const touched = new Date();
  await utimes(lockPath, touched, touched);
}

async function confirm(
  lockPath: string,
  expected: LockRecord,
  heartbeatIntervalMs: number,
): Promise<ReconcileLock> {
  // Read-back identity check: stops us proceeding on a lock that a
  // concurrent reclaim has already replaced.
  await refreshLock(lockPath, expected);
  let heartbeatError: Error | undefined;
  const timer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          void refreshLock(lockPath, expected).catch((e) => {
            heartbeatError = e instanceof Error ? e : new Error(String(e));
          });
        }, heartbeatIntervalMs)
      : undefined;
  timer?.unref?.();
  return {
    async heartbeat() {
      if (heartbeatError) throw heartbeatError;
      await refreshLock(lockPath, expected);
    },
    async release() {
      if (timer) clearInterval(timer);
      // Identity-check before unlink: if a stale pause exceeded the TTL
      // and another holder reclaimed the lock, our unlink would delete
      // the new holder's record and let a third contender slip through.
      try {
        const settledNow = await readLock(lockPath);
        if (sameHolder(settledNow.lock, expected)) {
          await unlink(lockPath);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
      }
    },
  };
}

// Re-export path helpers for callers that want the lock file path.
export function reconcileLockPath(sidecarPath: string): string {
  return sidecarPath + ".lock";
}

export async function acquireSidecarLock(deps: {
  acquireLock?: (sidecarPath: string) => Promise<ReconcileLock>;
  sidecarFilePath?: string;
}): Promise<ReconcileLock> {
  if (deps.acquireLock) return deps.acquireLock(deps.sidecarFilePath ?? "");
  if (!deps.sidecarFilePath) {
    throw new Error(
      "OpenAI batch submit/reconcile requires sidecarFilePath so the create-window lock has a path to lock",
    );
  }
  return acquireReconcileLock(deps.sidecarFilePath);
}
