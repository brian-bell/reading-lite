/** Namespace enumeration for the residue scan. Discovery uses the index-wide
 * snapshot list, never similarity topK. Hydration is a later read: missing IDs
 * are unknown, not absent.
 *
 * The bare-vector repair that used to live here went with
 * `account audit-bare-vectors` (reading-lite-gh347.4.6): a bare vector is
 * unrepresentable once `reading_embeddings` has a foreign key to `readings`.
 */
// A vector as the legacy Vectorize index returns it. `namespace` is absent for
// a pre-tenant vector; the REST adapter normalizes the wire's null to that.
export interface StoredVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}
export interface AuditVectors {
  list(cursor?: string): Promise<{
    vectors: { id: string }[];
    isTruncated: boolean;
    // Required and validated on the REST wire; optional for in-memory clients.
    count?: number;
    totalCount?: number;
    nextCursor?: string | null;
  }>;
  get(ids: string[]): Promise<StoredVector[]>;
  upsert(vector: StoredVector): Promise<void>;
  delete(ids: string[]): Promise<void>;
}
export async function enumerateNamespace(client: AuditVectors, tenant: string) {
  const ids = new Set<string>();
  const pageCounts: { count?: number; totalCount?: number }[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.list(cursor);
    if (page.count !== undefined && page.count !== page.vectors.length)
      throw new Error("vector list page count does not match returned IDs");
    // https://developers.cloudflare.com/vectorize/best-practices/list-vectors/
    // documents count per page and snapshot IDs, but does not pin totalCount
    // under concurrent mutations. Retain totals as evidence without asserting
    // cross-page equality or equating later hydration with that snapshot.
    pageCounts.push({ count: page.count, totalCount: page.totalCount });
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
  return { vectors, unknown, enumerated: ids.size, pageCounts };
}
