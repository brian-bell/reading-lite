// The manifest-read cache the tier-2 and tier-3 planning passes share.
//
// Both commands walk their ids in a fixed order and read one manifest per id,
// reporting each failure in its own words at its own point in the loop. The
// reads themselves are independent, so they are issued ahead of the loop, a
// bounded number at a time, into a cache the loop then consults. Each outcome,
// success or failure, is recorded rather than thrown, which is what lets the
// loop keep its ordering and its messages while the requests overlap.

import { mapWithConcurrency } from "../lib/concurrency";

// Planning reads are independent GETs against R2. Eight is where the staging
// probe showed added parallelism stops paying (8 concurrent GETs took 178 ms
// against 73 ms for one) and is well inside R2's per-bucket limits.
export const PLANNING_READ_CONCURRENCY = 8;

export interface PrefetchingReader<T> {
  /** Reads the given keys concurrently into the cache, at most once each. */
  prefetch(keys: readonly string[]): Promise<void>;
  /** The cached outcome for `key`, reading it on demand if it was not fetched. */
  read(key: string): Promise<T>;
}

export function createPrefetchingReader<T>(
  read: (key: string) => Promise<T>,
  concurrency: number = PLANNING_READ_CONCURRENCY,
): PrefetchingReader<T> {
  const values = new Map<string, T>();
  const errors = new Map<string, Error>();

  const load = async (key: string): Promise<void> => {
    try {
      values.set(key, await read(key));
    } catch (cause) {
      errors.set(key, cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  return {
    async prefetch(keys) {
      const pending: string[] = [];
      const queued = new Set<string>();
      for (const key of keys) {
        if (queued.has(key) || values.has(key) || errors.has(key)) continue;
        queued.add(key);
        pending.push(key);
      }
      await mapWithConcurrency(pending, concurrency, load);
    },
    async read(key) {
      const failed = errors.get(key);
      if (failed) throw failed;
      if (values.has(key)) return values.get(key) as T;
      await load(key);
      const late = errors.get(key);
      if (late) throw late;
      return values.get(key) as T;
    },
  };
}
