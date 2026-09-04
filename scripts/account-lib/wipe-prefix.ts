// The `wipe/` prefix vocabulary and the guard that decides whether an object
// key may be deleted by `ops account sweep-wipe-prefix`.
//
// Background (issue #195, slice S2). The account wipe keeps its resume record
// at `wipe/{tenantId}/progress.json` — a BUCKET-ROOT key, deliberately outside
// the tenant key root, because it must survive the deletion of everything under
// `u/{tenantId}/`. S2 moves that state into D1 and deletes the only code that
// ever removed the R2 object, so any record left behind by an in-flight wipe at
// the moment S2 deploys becomes a permanent orphan: a key that names a deleted
// tenant, with a body carrying that tenant's `vector_cursor` (a reading id).
// This module is the sweep's safety half.
//
// The guard is structural, not a lucky string match. `PROTECTED_KEY_ROOTS` is
// derived from the key vocabulary in src/modules/stores/layout.ts and from
// `tenantKeyRoot` — the same builders the Worker stores address the bucket
// with — so if a corpus root is ever renamed, the roots this sweep refuses to
// touch move with it instead of silently going stale.

import { parseTenantId } from "../../src/control-plane/ids";
import { tenantKeyRoot } from "../../src/modules/stores/reading-store";
import {
  BY_ID_PREFIX,
  BY_URL_PREFIX,
  LIST_INDEX_KEY,
  READINGS_PREFIX,
  REFRESH_STATE_KEY,
} from "../../src/modules/stores/layout";

/**
 * The one prefix this sweep may delete under. Single-homed with
 * `accountWipeProgressKey` in src/account-wipe.ts, which spells the only key
 * the Worker ever writes here; the unit test pins the two together rather than
 * this module importing the Worker's queue consumer.
 */
export const WIPE_PREFIX = "wipe/";

/** The leading `<segment>/` of a key, or "" when the key has no separator. */
function rootSegment(key: string): string {
  const cut = key.indexOf("/");
  return cut < 0 ? "" : key.slice(0, cut + 1);
}

// A syntactically valid tenant id, used only to ask `tenantKeyRoot` how a
// tenant-rooted key is spelled. The id itself is meaningless — the answer's
// FIRST SEGMENT (`u/`) is what the guard needs, and taking it from the builder
// keeps this in step with the Worker's data plane.
const SAMPLE_TENANT_ID = parseTenantId("usr_00000000-0000-4000-8000-000000000000");
if (!SAMPLE_TENANT_ID) {
  throw new Error("wipe-prefix guard: the sample tenant id no longer parses");
}
const TENANT_ROOT_SEGMENT = rootSegment(tenantKeyRoot({ tenantId: SAMPLE_TENANT_ID }, true));

/**
 * Every key root the sweep must never delete under: the tenant data plane
 * (`u/`) and the legacy pre-cutover corpus roots (`readings/`, `index/`),
 * derived from the layout vocabulary rather than retyped.
 */
export const PROTECTED_KEY_ROOTS: readonly string[] = [
  ...new Set(
    [
      TENANT_ROOT_SEGMENT,
      rootSegment(READINGS_PREFIX),
      rootSegment(LIST_INDEX_KEY),
      rootSegment(REFRESH_STATE_KEY),
      rootSegment(BY_URL_PREFIX),
      rootSegment(BY_ID_PREFIX),
    ].filter((root) => root !== ""),
  ),
].sort();

// A prefix that is itself a corpus root would make the whole guard a lie, so
// the collision is checked once, at load, rather than trusted.
if (PROTECTED_KEY_ROOTS.some((root) => WIPE_PREFIX.startsWith(root) || root.startsWith(WIPE_PREFIX))) {
  throw new Error(
    `wipe-prefix guard: ${WIPE_PREFIX} collides with a protected corpus root (${PROTECTED_KEY_ROOTS.join(", ")})`,
  );
}

export type WipeKeyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether one object key may be deleted by the wipe-prefix sweep.
 *
 * Deletable means all of: it literally starts with `wipe/`; it names something
 * under that prefix rather than the prefix itself; every path segment is a real
 * segment (no empty, `.` or `..` segment that a normalizing storage layer could
 * resolve back out of the prefix); and it does not start with a protected
 * corpus root. The last check is redundant against the first by construction —
 * it is kept because "never touches the corpus" is the property this command
 * has to be able to prove, not one to leave implied.
 */
export function sweepableWipeKeyVerdict(key: string): WipeKeyVerdict {
  if (!key.startsWith(WIPE_PREFIX)) {
    return { ok: false, reason: `key does not start with ${WIPE_PREFIX}` };
  }
  const remainder = key.slice(WIPE_PREFIX.length);
  if (remainder === "") {
    return { ok: false, reason: `key is the bare ${WIPE_PREFIX} prefix, not an object under it` };
  }
  for (const segment of remainder.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, reason: `key has a non-literal path segment: ${JSON.stringify(segment)}` };
    }
  }
  for (const root of PROTECTED_KEY_ROOTS) {
    if (key.startsWith(root)) {
      return { ok: false, reason: `key is under the protected corpus root ${root}` };
    }
  }
  return { ok: true };
}

export function isSweepableWipeKey(key: string): boolean {
  return sweepableWipeKeyVerdict(key).ok;
}

/**
 * Last line of defence, called immediately before every delete: a key that
 * reached the delete path without passing the guard is a bug, and throwing is
 * the only outcome that cannot delete corpus data.
 */
export function assertSweepableWipeKey(key: string): void {
  const verdict = sweepableWipeKeyVerdict(key);
  if (!verdict.ok) {
    throw new Error(`refusing to delete ${JSON.stringify(key)}: ${verdict.reason}`);
  }
}
