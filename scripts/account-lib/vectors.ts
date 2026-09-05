/** S5 discovery uses the index-wide snapshot list, never similarity topK or
 * ledger coverage. Hydration is a later read: missing IDs are unknown, not
 * absent. Repairs require externally paused/drained writers; REST has no CAS
 * and delete_by_ids is namespace-blind. Never delete a global/legacy vector.
 */
import { isDeepStrictEqual } from "node:util";
import { parseReadingId } from "../../src/services";
import type { StoredVector } from "../lib/cf-clients";
export interface AuditVectors {
  list(cursor?: string): Promise<{
    vectors: { id: string }[];
    isTruncated: boolean;
    nextCursor?: string | null;
  }>;
  get(ids: string[]): Promise<StoredVector[]>;
  upsert(vector: StoredVector): Promise<void>;
  delete(ids: string[]): Promise<void>;
}
export async function enumerateNamespace(client: AuditVectors, tenant: string) {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.list(cursor);
    for (const { id } of page.vectors) ids.add(id);
    if (!page.isTruncated) break;
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new Error("invalid/non-advancing vector list cursor");
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (true);
  const vectors: StoredVector[] = [];
  const unknown: string[] = [];
  const all = [...ids].sort();
  for (let i = 0; i < all.length; i += 20) {
    const group = all.slice(i, i + 20);
    const found = await client.get(group);
    if (found.some((v) => !group.includes(v.id)))
      throw new Error("unexpected vector id in get_by_ids");
    for (const id of group)
      if (!found.some((v) => v.id === id)) unknown.push(id);
    vectors.push(...found.filter((v) => v.namespace === tenant));
  }
  return { vectors, unknown, enumerated: ids.size };
}
function payload(v: StoredVector) {
  return { values: v.values, metadata: v.metadata ?? {} };
}
/** Concrete plan verdict, shared with execute-time revalidation. */
export function bareRepairAction(
  tenant: string,
  bare: StoredVector,
  target: StoredVector | undefined,
  status: string,
  legacy: boolean,
) {
  if (!parseReadingId(bare.id) || bare.namespace !== tenant || legacy)
    return "refuse_legacy_or_namespace";
  if (status === "deleting" || status === "deleted") return "delete_bare";
  if (status !== "active") return "refuse_status";
  if (!target) return "copy_to_composed";
  if (
    target.namespace !== tenant ||
    !isDeepStrictEqual(payload(target), payload(bare))
  )
    return "refuse_conflicting_composed";
  return "delete_verified_duplicate";
}
export async function repairBareVector(
  client: AuditVectors,
  tenant: string,
  planned: StoredVector,
  opts: {
    status: string;
    legacy: boolean;
    ledger(id: string): Promise<unknown>;
  },
) {
  if (
    !parseReadingId(planned.id) ||
    planned.namespace !== tenant ||
    opts.legacy
  )
    throw new Error("refused global/legacy or invalid bare vector");
  const composed = `${tenant}:${planned.id}`;
  const current = await client.get([planned.id, composed]);
  const bare = current.find((v) => v.id === planned.id);
  if (
    !bare ||
    bare.namespace !== tenant ||
    !isDeepStrictEqual(payload(bare), payload(planned))
  )
    throw new Error("bare vector changed since plan");
  const target = current.find((v) => v.id === composed);
  const action = bareRepairAction(
    tenant,
    bare,
    target,
    opts.status,
    opts.legacy,
  );
  if (action.startsWith("refuse_"))
    throw new Error(`repair refused: ${action}`);
  if (action === "delete_bare") {
    await client.delete([bare.id]);
    return "delete_submitted";
  }
  await opts.ledger(bare.id);
  if (!target) {
    await client.upsert({ ...bare, id: composed });
    // Async upsert: a later invocation must observe the exact payload before
    // deleting the only copy. Re-running after any crash is safe.
    return "upsert_submitted";
  }
  await client.delete([bare.id]);
  return "delete_submitted";
}
