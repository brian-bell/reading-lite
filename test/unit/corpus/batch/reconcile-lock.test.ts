import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireReconcileLock,
  reconcileLockPath,
} from "../../../../scripts/corpus-lib/batch/reconcile-lock";

async function tempSidecar() {
  const dir = await mkdtemp(join(tmpdir(), "reading-lite-reconcile-lock-"));
  return { dir, sidecar: join(dir, "index.batch.json") };
}

describe("acquireReconcileLock", () => {
  it("acquires a fresh lock, releases on demand, and writes a sibling file", async () => {
    const { dir, sidecar } = await tempSidecar();
    try {
      const lock = await acquireReconcileLock(sidecar);
      const lockPath = reconcileLockPath(sidecar);
      const contents = await readFile(lockPath, "utf-8");
      expect(JSON.parse(contents)).toMatchObject({ pid: process.pid });
      await stat(lockPath);
      await lock.release();
      await expect(stat(lockPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when another live process holds the lock", async () => {
    const { dir, sidecar } = await tempSidecar();
    try {
      const first = await acquireReconcileLock(sidecar);
      try {
        await expect(
          acquireReconcileLock(sidecar, { pid: 999_999 }),
        ).rejects.toThrow(new RegExp(`is held by pid ${process.pid}`));
      } finally {
        await first.release();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("breaks a stale lock once and proceeds", async () => {
    const { dir, sidecar } = await tempSidecar();
    try {
      const lockPath = reconcileLockPath(sidecar);
      const first = await acquireReconcileLock(sidecar);
      // Backdate the lock file's mtime past the TTL so the next acquirer
      // sees it as stale. (Node's mtime precision is whole seconds on some
      // filesystems; subtract enough.)
      const ancient = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lockPath, ancient, ancient);
      await first.release();
      // The release unlinked the file; recreate with the ancient mtime so
      // the next acquire walks the stale branch. (We have to recreate
      // because the broken-lock rename above is keyed off the lock being
      // present.)
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 1, host: "stale", started_at: ancient.toISOString() }) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
      await utimes(lockPath, ancient, ancient);
      const second = await acquireReconcileLock(sidecar);
      try {
        const contents = await readFile(lockPath, "utf-8");
        // The new holder's pid (current process) overwrote the broken lock.
        expect(JSON.parse(contents)).toMatchObject({ pid: process.pid });
      } finally {
        await second.release();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});