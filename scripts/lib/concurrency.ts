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
