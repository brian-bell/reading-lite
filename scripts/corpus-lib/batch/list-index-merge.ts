import type { ListIndexItem } from "../../../src/schemas/api";
import { PointerExistsError, type R2Client } from "../../lib/cf-clients";

export const LIST_INDEX_KEY = "index/list.json";

export interface MergeListIndexDeps {
  r2: R2Client;
  log?: (line: string) => void;
  // Compare-and-set tuning, injectable for deterministic tests. Defaults mirror
  // the Worker's ListIndexStore.
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Merge `touched` rows into index/list.json under an optimistic compare-and-set,
// mirroring the Worker's ListIndexStore.mutateListIndex. Shared by the eager-claim
// phase (pending rows) and the terminal write phase (ready / failed rows) so the
// two writers can't drift in how they dedupe.
//
// CAS (not a plain read-modify-write) is load-bearing now that the eager by-url
// claim lets a backfill run CONCURRENTLY with live online traffic: an unrelated
// online submit/terminal write can mutate index/list.json between our read and our
// write, and a blind PUT would drop that row (permanently, if it was terminal).
// We read the etag, conditionally PUT `If-Match: <etag>` (or `If-None-Match: *`
// when the index is absent), and on a 412 re-read + re-merge against the latest
// rather than clobbering the concurrent writer — exactly what the Worker does, so
// online (R2 binding `etagMatches`) and offline (S3 `If-Match`) converge on the
// same object without losing entries.
export async function mergeListIndex(deps: MergeListIndexDeps, touched: ListIndexItem[]): Promise<void> {
  if (touched.length === 0) return;
  const maxAttempts = deps.maxAttempts ?? 8;
  const baseDelayMs = deps.baseDelayMs ?? 20;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await deps.r2.getWithEtag(LIST_INDEX_KEY);
    let items: ListIndexItem[] = [];
    if (current) {
      try {
        const parsed = JSON.parse(current.body) as { items?: ListIndexItem[] };
        if (Array.isArray(parsed.items)) items = parsed.items;
      } catch {
        deps.log?.(`  ! index/list.json was unparseable; rebuilding from touched items only`);
      }
    }
    // Drop any existing row that collides with a touched row on EITHER id or
    // key_prefix. The id filter is the normal replace-in-place; the key_prefix
    // filter cleans up the cross-wired/stale case where a row's id disagrees with
    // the manifest its key_prefix points at (the cold lookup re-ingests under the
    // manifest's real id, so the old row id would otherwise survive as a bogus
    // duplicate). A key_prefix encodes its reading id (`...-rd_x`), so it is unique
    // per reading — filtering by it can only ever remove the stale twin.
    const touchedIds = new Set(touched.map((t) => t.id));
    const touchedKeyPrefixes = new Set(touched.map((t) => t.key_prefix));
    const merged = [
      ...items.filter((i) => !touchedIds.has(i.id) && !touchedKeyPrefixes.has(i.key_prefix)),
      ...touched,
    ];
    const body = JSON.stringify({ version: 1, items: merged });

    try {
      await deps.r2.put(
        LIST_INDEX_KEY,
        body,
        current
          ? { contentType: "application/json", ifMatch: current.etag }
          : { contentType: "application/json", ifNoneMatch: "*" },
      );
      return;
    } catch (err) {
      if (!(err instanceof PointerExistsError)) throw err;
      // Lost the CAS (a concurrent writer changed/created the index): re-read and
      // re-merge against what they wrote rather than clobbering it.
      if (attempt < maxAttempts - 1) {
        await sleep(Math.floor(random() * baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw new Error(
    `mergeListIndex: exhausted ${maxAttempts} CAS attempts on ${LIST_INDEX_KEY} under contention`,
  );
}
