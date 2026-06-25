import { ManifestSchema } from "../../../src/schemas/manifest";
import type { R2Client } from "../../lib/cf-clients";
import type { Sidecar } from "./types";

export interface HeartbeatDeps {
  r2: R2Client;
  now(): string;
  // Minimum wall-clock between sweeps. Must be comfortably under the Worker's
  // PENDING_TTL_SECONDS so an eager pending never ages into "stale" mid-batch.
  intervalMs?: number;
  log?(line: string): void;
}

// 5 minutes — well under the 900s production PENDING_TTL_SECONDS.
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Build the poll-loop heartbeat: it re-stamps the eager pending manifests'
// `updated_at` so the online staleness rule (PENDING_TTL_SECONDS) never flips
// them to `failed` and reprocesses them while the Message Batch is genuinely in
// flight (minutes-to-hours, longer than the TTL). Without this, an online submit
// for one of the batch's URLs would annotate the stale pending failed and start a
// competing reprocess — reopening the issue #66 duplicate-compute race after the
// TTL elapses.
//
// Resume-safe: it works from the sidecar targets (the resume boundary), reading
// each manifest and only re-stamping a still-`pending` one. A ready-kept recover
// target (`preserveReadyManifest` set) is never touched — its slot is already
// defended as owned+ready. If the batch process dies, the pendings simply stop
// being refreshed and age out, and the online path recovers them — graceful.
//
// Scope: this re-stamps only the manifest, which is the timestamp the online
// duplicate-compute defense reads (`submitResultForOwnedReading` → annotateStale
// → the manifest). It deliberately does NOT re-stamp the `index/list.json` row,
// so past TTL the reading may *display* as failed in list/search
// (annotateStaleIndexItem) while genuinely in flight — purely cosmetic and
// self-corrected by the terminal write; not the race.
//
// The returned function is meant to be passed as the poll loop's `onTick`. The
// FIRST tick always sweeps immediately, then it is gated to at most once per
// `intervalMs`. The immediate first sweep is load-bearing for RESUME: a resumed
// run's pendings were last stamped by a previous (possibly long-dead) process and
// may already be stale, so we must refresh them on the very first poll rather than
// wait a full interval (which would leave a TTL-sized window where an online
// submit reprocesses them — the exact issue #66 race). On a fresh run the claim
// stamped the manifests moments ago, so the first sweep is merely a harmless
// redundant re-stamp.
export function makePendingHeartbeat(sidecar: Sidecar, deps: HeartbeatDeps): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let lastSweepMs: number | null = null;

  return async function heartbeat(): Promise<void> {
    const nowIso = deps.now();
    const nowMs = Date.parse(nowIso);
    // null = never swept → sweep now (covers the resume case above).
    if (lastSweepMs !== null && nowMs - lastSweepMs < intervalMs) return;
    lastSweepMs = nowMs;

    let refreshed = 0;
    for (const t of sidecar.targets) {
      // A ready-kept recover target owns its slot as ready — leave it alone.
      if (t.preserveReadyManifest) continue;
      const raw = await deps.r2.get(`${t.keyPrefix}/manifest.json`);
      if (!raw) continue;
      let manifest;
      try {
        manifest = ManifestSchema.parse(JSON.parse(raw));
      } catch {
        continue;
      }
      if (manifest.status !== "pending") continue;
      // Don't touch a pending the online path is actively reprocessing: the batch's
      // own eager pending carries NO active_attempt, so any active_attempt here is
      // a foreign online worker mid-flight. Re-stamping would change the etag under
      // its readManifestWithEtag → replaceManifestIfCurrent CAS and make it drop a
      // good result. Leave it; if it's actually stranded it ages out on its own.
      if (manifest.active_attempt !== undefined) continue;
      const restamped = ManifestSchema.parse({ ...manifest, updated_at: nowIso });
      await deps.r2.put(`${t.keyPrefix}/manifest.json`, JSON.stringify(restamped), {
        contentType: "application/json",
      });
      refreshed++;
    }
    if (refreshed > 0) deps.log?.(`  heartbeat: refreshed ${refreshed} pending manifest(s)`);
  };
}
