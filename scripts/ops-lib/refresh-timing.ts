// Wall-clock instrumentation for the three corpus refresh commands.
//
// A refresh pass is a long sequential loop over storage and provider calls,
// and until now the only visible number was the total the operator measured
// with a stopwatch. That made a slow run indistinguishable from a hung one:
// a stalled read and an ordinary 16-minute plan print the same thing (nothing)
// while they are running. The timer groups every awaited call into a named
// phase, counts the calls, and prints the totals at the end of the run, so the
// next run can be compared against a recorded baseline rather than a memory.
//
// Durations come from the command's injected `now`, the same clock the
// commands already use for manifest timestamps, so tests drive them with a
// fake clock instead of real waiting. That clock is wall time, not a monotonic
// one: a clock step mid-pass (NTP, suspend/resume) shows up in the numbers.
//
// A phase appears in the block only when it was used, in the order it was
// first used, which is the order the pass performs them.
//
// A phase total is the sum of its call durations, not the wall time it
// occupied. Where a pass overlaps its calls — planning reads run eight at a
// time — the sum is larger than the wall time, and the `total` line is the one
// to compare between runs.

import type { CorpusRefreshNeighboursR2 } from "./commands/corpus-refresh-neighbours";
import type { RefreshConnectionsStorage } from "./commands/corpus-refresh-connections";

export const PHASE_LIST_READ = "list read";
export const PHASE_PLANNING_READS = "planning reads";
export const PHASE_MANIFEST_READ = "manifest read";
export const PHASE_MANIFEST_WRITE = "manifest write";
export const PHASE_LIST_WRITE = "list write";
export const PHASE_PROVIDER = "provider";
export const PHASE_VECTORIZE_QUERY = "vectorize query";

export interface RefreshTimer {
  /** Times one awaited call into `phase`, counting failures too. */
  measure<T>(phase: string, fn: () => Promise<T>): Promise<T>;
  /** Times one awaited call and also hands back its own duration. */
  measured<T>(phase: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }>;
  /** The `Timing:` block, without a trailing newline. */
  format(): string;
  /** True once at least one call has been timed. */
  used(): boolean;
}

/**
 * Prints the block, unless nothing was timed — a run that failed on its
 * arguments has no phases to report, and `total 0.000s` under a usage error is
 * noise.
 */
export function printTiming(timer: RefreshTimer, write: (line: string) => void): void {
  if (timer.used()) write(`\n${timer.format()}`);
}

interface Phase {
  calls: number;
  ms: number;
}

export function createRefreshTimer(now: () => number): RefreshTimer {
  const start = now();
  const phases = new Map<string, Phase>();

  const record = (phase: string, ms: number): void => {
    const entry = phases.get(phase) ?? { calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += ms;
    phases.set(phase, entry);
  };

  const measured = async <T>(
    phase: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; ms: number }> => {
    const startedAt = now();
    // Read the clock exactly once more, whether the call returned or threw, so
    // the recorded duration is the one reported back for the same call. A
    // backward clock step floors at zero rather than reporting -0.500s.
    const since = () => Math.max(0, now() - startedAt);
    let elapsed = 0;
    try {
      const value = await fn();
      elapsed = since();
      return { value, ms: elapsed };
    } catch (error) {
      // A failed call still consumed wall time — and a timeout consumes the
      // most — so it is counted rather than dropped.
      elapsed = since();
      throw error;
    } finally {
      record(phase, elapsed);
    }
  };

  return {
    measure: async (phase, fn) => (await measured(phase, fn)).value,
    measured,
    format: () => formatTiming([...phases.entries()], Math.max(0, now() - start)),
    used: () => phases.size > 0,
  };
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

function formatTiming(entries: Array<[string, Phase]>, totalMs: number): string {
  const TOTAL = "total";
  const labelWidth = Math.max(TOTAL.length, ...entries.map(([label]) => label.length));
  const counts = entries.map(([, phase]) => callCount(phase.calls));
  const countWidth = Math.max(0, ...counts.map((count) => count.length));
  const seconds = [...entries.map(([, phase]) => formatSeconds(phase.ms)), formatSeconds(totalMs)];
  const secondsWidth = Math.max(...seconds.map((value) => value.length));

  const lines = ["Timing:"];
  entries.forEach(([label, phase], index) => {
    lines.push(
      `  ${label.padEnd(labelWidth)}  ${counts[index]!.padStart(countWidth)}  ` +
        `${formatSeconds(phase.ms).padStart(secondsWidth)}`,
    );
  });
  lines.push(
    `  ${TOTAL.padEnd(labelWidth)}  ${"".padStart(countWidth)}  ` +
      `${formatSeconds(totalMs).padStart(secondsWidth)}`,
  );
  return lines.join("\n");
}

function callCount(calls: number): string {
  return `${calls} call${calls === 1 ? "" : "s"}`;
}

/**
 * Times tier-1's storage surface. Manifest reads are one phase here because
 * tier 1 measures and writes in a single loop; there is no separate planning
 * pass to attribute them to.
 */
export function timedNeighboursR2(
  r2: CorpusRefreshNeighboursR2,
  timer: RefreshTimer,
): CorpusRefreshNeighboursR2 {
  return {
    readListIndex: (deps) => timer.measure(PHASE_LIST_READ, () => r2.readListIndex(deps)),
    readManifest: (keyPrefix, deps) =>
      timer.measure(PHASE_MANIFEST_READ, () => r2.readManifest(keyPrefix, deps)),
    queryByVectorId: (index, id, topK, namespace) =>
      timer.measure(PHASE_VECTORIZE_QUERY, () => r2.queryByVectorId(index, id, topK, namespace)),
    putManifest: (keyPrefix, body, deps) =>
      timer.measure(PHASE_MANIFEST_WRITE, () => r2.putManifest(keyPrefix, body, deps)),
    writeListIndex: (items, deps) =>
      timer.measure(PHASE_LIST_WRITE, () => r2.writeListIndex(items, deps)),
  };
}

/**
 * Times the tier-2/3 storage surface. `manifestReadPhase` is what a command
 * uses to say which reads are the fixed planning cost every invocation repays
 * and which are not: tier 3 flips it when it stops planning, since it re-reads
 * a side it has already written, while tier 2 reads nothing after planning and
 * passes the planning phase throughout.
 */
export function timedRefreshStorage(
  storage: RefreshConnectionsStorage,
  timer: RefreshTimer,
  manifestReadPhase: () => string,
): RefreshConnectionsStorage {
  return {
    readListIndex: () => timer.measure(PHASE_LIST_READ, () => storage.readListIndex()),
    readManifest: (keyPrefix) =>
      timer.measure(manifestReadPhase(), () => storage.readManifest(keyPrefix)),
    putManifestIfMatch: (keyPrefix, manifest, etag) =>
      timer.measure(PHASE_MANIFEST_WRITE, () => storage.putManifestIfMatch(keyPrefix, manifest, etag)),
    writeListIndex: (items) => timer.measure(PHASE_LIST_WRITE, () => storage.writeListIndex(items)),
  };
}
