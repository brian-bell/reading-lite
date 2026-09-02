// The `index/list.json` flush shared by the tier-1 (`refresh-neighbours`) and
// tier-2 (`refresh-connections`) corpus refresh commands.
//
// Both commands used to end by putting back the whole list document they had
// read minutes earlier: every row the corpus gained or changed in between —
// a queue-consumer activation, a purge, another operator's write — was silently
// reverted to the read-time snapshot. That is the clobber `--sole-writer`
// exists to make unlikely rather than impossible.
//
// This is `ListIndexStore.mutateListIndex` (src/modules/stores/list-index.ts)
// in operator clothing: read the live document with its ETag, apply the run's
// row patches to the rows it actually touched, and put it back under If-Match,
// re-reading and re-applying with jittered backoff when a concurrent writer
// wins the race. Two properties follow. A row this run never measured is
// written back exactly as the live document has it, so a concurrent insertion
// survives the flush; and a row it did measure carries only the fields the
// refresh owns, so a title or status written concurrently is not reverted.
//
// A patch names one row and the subset of MERGEABLE_ROW_FIELDS this run
// decided: tier 1 writes `similarity`, tier 2 writes `novelty_verdict`. A
// present key with an `undefined` value deletes the field, which is how tier 2
// clears a stale verdict off a healed row.

/** The only list-row fields a refresh pass may write. */
export const MERGEABLE_ROW_FIELDS = ["similarity", "novelty_verdict"] as const;

export interface ListRowPatch {
  id: string;
  /** Present key = write this field; `undefined` = remove it from the row. */
  similarity?: unknown;
  novelty_verdict?: unknown;
}

export interface ListIndexCasClient {
  getWithEtag(key: string): Promise<{ body: string; etag: string } | null>;
  putIfMatch(
    key: string,
    body: string,
    etag: string,
    opts?: { contentType?: string },
  ): Promise<boolean>;
}

/** Injectable so tests drive contention deterministically without real sleeps. */
export interface ListIndexCasDeps {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface ResolvedCasDeps {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

function resolveDeps(deps: ListIndexCasDeps): ResolvedCasDeps {
  return {
    maxAttempts: deps.maxAttempts ?? 8,
    baseDelayMs: deps.baseDelayMs ?? 20,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random ?? Math.random,
  };
}

/**
 * Applies the patches to the rows that carry their ids. Rows with no patch are
 * returned untouched (identity, not a copy), and a patch whose row is absent —
 * the reading was purged while the run was measuring — is dropped rather than
 * resurrecting the row from a stale snapshot.
 */
export function mergeListRows<T extends { id: string }>(
  items: readonly T[],
  patches: readonly ListRowPatch[],
): T[] {
  if (patches.length === 0) return [...items];
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return items.map((item) => {
    const patch = byId.get(item.id);
    return patch === undefined ? item : applyRowPatch(item, patch);
  });
}

function applyRowPatch<T extends { id: string }>(item: T, patch: ListRowPatch): T {
  const next: Record<string, unknown> = { ...item };
  for (const field of MERGEABLE_ROW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as T;
}

/**
 * Read-merge-write of `index/list.json` under If-Match. Throws when the
 * document is missing, unreadable, or still contended after `maxAttempts` —
 * both commands already treat a failed flush as an incomplete run.
 */
export async function casMergeListIndex(
  client: ListIndexCasClient,
  key: string,
  patches: readonly ListRowPatch[],
  deps: ListIndexCasDeps = {},
): Promise<void> {
  if (patches.length === 0) return;
  const cas = resolveDeps(deps);

  for (let attempt = 0; attempt < cas.maxAttempts; attempt++) {
    const object = await client.getWithEtag(key);
    // Unlike the Worker's store, an operator flush never creates this object:
    // the run read it minutes ago, so absent means someone deleted the corpus
    // index under us and recreating it from a stale snapshot would be worse
    // than failing.
    if (object === null) {
      throw new Error(`${key} not found; refusing to recreate it from a refresh pass`);
    }
    // An empty token would turn the If-Match into a write we cannot reason
    // about; R2 always sends an ETag, so this is a broken response.
    if (object.etag === "") throw new Error(`${key} was read without an ETag`);

    const merged = mergeListRows(parseItems(object.body, key), patches);
    const written = await client.putIfMatch(
      key,
      JSON.stringify({ version: 1, items: merged }),
      object.etag,
      { contentType: "application/json" },
    );
    if (written) return;

    if (attempt < cas.maxAttempts - 1) {
      await cas.sleep(backoffMs(cas, attempt));
    }
  }

  throw new Error(
    `${key} write failed: exhausted ${cas.maxAttempts} CAS attempts under contention`,
  );
}

function parseItems(body: string, key: string): Array<{ id: string }> {
  const parsed: unknown = JSON.parse(body);
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`${key} has no items array`);
  return items as Array<{ id: string }>;
}

// Exponential backoff with full jitter, mirroring the Worker's list-index CAS.
function backoffMs(cas: ResolvedCasDeps, attempt: number): number {
  return Math.floor(cas.random() * cas.baseDelayMs * 2 ** attempt);
}
