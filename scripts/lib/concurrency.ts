// Bounded-concurrency mapping for the operator scripts.
//
// The corpus commands issue hundreds of independent storage reads inside a
// single sequential loop, which makes a plan pass cost (requests × latency)
// even though nothing in it depends on anything else. This runs a fixed pool
// of workers over the input and collects results by input index, so the caller
// keeps the deterministic ordering its output and its tests rely on while the
// requests overlap.
//
// A rejection aborts the pass: workers stop pulling new items, the ones already
// in flight are awaited so nothing is left dangling, and the first error
// observed is rethrown. Callers that want per-item failure isolation catch
// inside `fn` and return a result object instead.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  // A non-finite limit would otherwise produce zero workers and silently
  // return an array of holes without ever calling `fn`.
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workers = Math.max(1, Math.min(requested, items.length));
  let next = 0;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failures.push(error);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  // The first failure recorded is the one reported; the rest belong to items
  // that were already in flight when it landed.
  if (failures.length > 0) throw failures[0];
  return results;
}

// Bounded-concurrency mapping where some items must not run at the same time.
//
// The tier-3 execute pass judges pairs of readings and writes both sides of
// each pair, and a reading sits in several pairs. Two workers holding the same
// manifest at the same ETag would both pay for a judgement and the second
// would lose the CAS, so `--concurrency` on a healthy corpus would manufacture
// failures that a sequential pass never sees. `keysOf` names the resources an
// item takes exclusively — the reading ids it writes — and an item is
// dispatched only once every key it names is free. Items that share no key
// still overlap freely, so the cap is the only limit on tier 2, whose actions
// each name one reading.
//
// A worker never holds a key while waiting for another, so there is no
// deadlock: it picks the first pending item it can run outright, and otherwise
// waits for some in-flight item to release its keys.
//
// Results are handed to `onResult` in input order, not completion order, and
// as early as that order allows: a completed item is emitted once every item
// before it has been emitted. Callers keep the ordering their output and their
// tests rely on without waiting for the whole pass to finish, which matters
// when the pass is minutes of provider calls.
//
// As with `mapWithConcurrency`, a rejection aborts the pass: workers stop
// pulling, the ones in flight are awaited, every result that completed before
// the gap is still emitted, and the first error observed is rethrown. Callers
// wanting per-item failure isolation catch inside `fn` and return a result
// object instead.
export async function runKeyedPool<T, R>(
  items: readonly T[],
  limit: number,
  keysOf: (item: T, index: number) => readonly string[],
  fn: (item: T, index: number) => Promise<R>,
  onResult: (result: R, index: number) => void,
): Promise<void> {
  const count = items.length;
  if (count === 0) return;
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workers = Math.max(1, Math.min(requested, count));

  const results = new Array<R>(count);
  const settled = new Array<boolean>(count).fill(false);
  // Asked once per item rather than once per dispatch attempt: `claim` scans
  // the pending list on every turn, so calling `keysOf` there would make the
  // scheduling quadratic in a pass whose whole point is going faster.
  const keys = items.map((item, index) => keysOf(item, index));
  const pending = Array.from({ length: count }, (_, index) => index);
  const busy = new Set<string>();
  const waiters: Array<() => void> = [];
  let inFlight = 0;
  let emitted = 0;
  const failures: unknown[] = [];

  const wake = (): void => {
    while (waiters.length > 0) waiters.shift()!();
  };
  // Emit the longest prefix that is complete, so output order is input order
  // however the calls interleave. The cursor advances before the callback runs:
  // a callback that throws must not leave its own index to be emitted a second
  // time by whichever worker flushes next.
  const flush = (): void => {
    while (emitted < count && settled[emitted]) {
      const index = emitted++;
      onResult(results[index]!, index);
    }
  };
  const claim = (): number | undefined => {
    for (let slot = 0; slot < pending.length; slot++) {
      const index = pending[slot]!;
      if (keys[index]!.some((key) => busy.has(key))) continue;
      pending.splice(slot, 1);
      for (const key of keys[index]!) busy.add(key);
      return index;
    }
    return undefined;
  };

  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = claim();
      if (index === undefined) {
        if (pending.length === 0) return;
        // Items remain but none can run, so they are waiting on a key some
        // in-flight item holds. With nothing in flight no key can be held, so
        // this is unreachable; say so loudly rather than returning and leaving
        // those items silently unrun.
        if (inFlight === 0) {
          // Reported the same way as any other failure rather than thrown from
          // here, so the siblings still in flight are awaited and the parked
          // workers are woken before the caller sees it.
          failures.push(new Error("runKeyedPool deadlocked: pending items with no holder"));
          wake();
          return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      inFlight++;
      try {
        results[index] = await fn(items[index]!, index);
        settled[index] = true;
        flush();
      } catch (error) {
        failures.push(error);
      } finally {
        inFlight--;
        for (const key of keys[index]!) busy.delete(key);
        wake();
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  // Items that finished behind the failure are still handed over: their work
  // is done and, for these commands, already written, so dropping them would
  // leave the caller's accounting short of what actually happened. The prefix
  // stops at the failed item, which has no result to emit.
  flush();
  if (failures.length > 0) throw failures[0];
}
