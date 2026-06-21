// Ownership-aware deletion planning shared by `corpus-drop` and
// `corpus-delete-orphans`. The two scripts use different R2 access shims
// (wrangler-r2's `R2Deps` vs delete-orphans' local `getObject`), so the manifest
// and object reads are injected here, keeping this logic unit-testable without
// real R2.
//
// The subtle part is the by-url pointer. Under eager URL ownership (#33) the
// `index/by-url/{hash}` pointer records *ownership*, not readiness: a failed or
// pending reading may legitimately own it. But an orphan-duplicate's URL hashes
// to the SAME slot as the surviving ready copy, and that pointer belongs to the
// survivor. So we delete `index/by-url/{hash}` ONLY when the stored pointer's id
// equals the dropped reading id — never when it points at someone else, and
// never when it is absent.

import { urlHash } from "./url-hash";

const COMMON_RAW_EXTS = ["html", "txt", "json", "pdf", "bin", "md"];

export interface DeletePlanDeps {
  // Reads and parses the reading's manifest, or null when absent/unparseable.
  readManifest: (keyPrefix: string) => Promise<unknown | null>;
  // Reads a raw R2 object body as a string, or null when the key is absent.
  readObject: (key: string) => Promise<string | null>;
}

// Every deletable key under one dropped reading's id-scoped prefix, plus its
// by-url ownership pointer — but only when the dropped reading actually owns it.
//
// Attempt coverage is limited to the manifest's active_attempt + last_attempt.
// Each reprocess writes a new attempts/{at_*}.json, but the manifest records
// only those two ids, and the `wrangler r2 object` CLI (the cleanup tools' only
// R2 access) has no prefix list. So a reading reprocessed >2x can orphan earlier
// attempt JSONs. They're tiny, invisible to audits, and dangle nothing
// (manifest/by-id/list entry are all gone), so this is accepted minor residue
// rather than a correctness problem.
export async function keysForDroppedReading(
  id: string,
  keyPrefix: string,
  url: string,
  deps: DeletePlanDeps,
): Promise<string[]> {
  const keys = new Set<string>([
    `${keyPrefix}/manifest.json`,
    `${keyPrefix}/extracted.md`,
    `index/by-id/${id}`,
  ]);
  for (const ext of COMMON_RAW_EXTS) keys.add(`${keyPrefix}/raw.${ext}`);

  const m = (await deps.readManifest(keyPrefix)) as Record<string, any> | null;
  if (m) {
    for (const k of ["active_attempt", "last_attempt"]) {
      const at = m?.[k]?.id;
      if (typeof at === "string") keys.add(`${keyPrefix}/attempts/${at}.json`);
    }
  }

  const pointerKey = await byUrlPointerKeyIfOwned(id, url, deps.readObject);
  if (pointerKey) keys.add(pointerKey);

  return [...keys];
}

// Returns `index/by-url/{sha256(url)}` only when the stored pointer object is
// owned by `droppedId`. Returns null when the pointer is owned by another
// (surviving) reading, is absent, or is unparseable — so cleanup never deletes a
// pointer a different reading depends on.
//
// The slot is recomputed from `url` rather than read from the manifest's stored
// `url_hash`, and that is safe: the worker derives `manifest.url`,
// `manifest.url_hash = sha256Hex(manifest.url)`, and the list/audit `url` (a copy
// of `manifest.url`) from one identical string with no normalization, and the
// Node `urlHash` helper is unit-tested to reproduce the worker `sha256Hex`. So
// `urlHash(url) === manifest.url_hash` by construction; recomputing keeps this
// helper usable when the manifest is absent/corrupt (its `url_hash` gone) and
// independent of the manifest read.
export async function byUrlPointerKeyIfOwned(
  droppedId: string,
  url: string,
  readObject: (key: string) => Promise<string | null>,
): Promise<string | null> {
  const key = `index/by-url/${urlHash(url)}`;
  const raw = await readObject(key);
  if (raw === null) return null;
  let pointer: unknown;
  try {
    pointer = JSON.parse(raw);
  } catch {
    return null;
  }
  if (pointer && typeof pointer === "object" && (pointer as { id?: unknown }).id === droppedId) {
    return key;
  }
  return null;
}
