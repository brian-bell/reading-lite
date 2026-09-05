/** Strict operator REST adapter. Bucket fixes D1, Vectorize and queue pairing;
 * no environment-variable index override can silently redirect an audit.
 * No Worker HTTP/admin surface and no production dependency is added.
 */
import { z } from "zod";
import { loadDotVars } from "../lib/dotvars";
import { r2InventoryClientFromVars } from "../lib/cf-clients";
import {
  controlPlaneDbForBucket,
  controlPlaneForBucket,
} from "./control-plane";
import type { AuditVectors } from "./vectors";
const Vector = z.object({
  id: z.string(),
  namespace: z.string().nullish(),
  values: z.array(z.number().finite()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export function accountRemote(
  bucket: string,
  fetchFn: typeof fetch = fetch,
  vars: Record<string, string | undefined> = {
    ...loadDotVars(".corpus.vars"),
    ...process.env,
  },
) {
  const target = controlPlaneForBucket(bucket);
  if (!target) throw new Error(`unmapped account bucket: ${bucket}`);
  const account =
    vars.CORPUS_VECTORIZE_ACCOUNT_ID ??
    vars.CORPUS_R2_ACCOUNT_ID ??
    vars.CLOUDFLARE_ACCOUNT_ID;
  const token = vars.CORPUS_CF_API_TOKEN ?? vars.CLOUDFLARE_API_TOKEN;
  if (!account || !token)
    throw new Error(
      "account operations require CORPUS_R2_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID and CORPUS_CF_API_TOKEN/CLOUDFLARE_API_TOKEN",
    );
  async function request(
    path: string,
    body?: unknown,
    ndjson = false,
  ): Promise<unknown> {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": ndjson ? "application/x-ndjson" : "application/json",
        },
        ...(body === undefined
          ? {}
          : { body: ndjson ? String(body) : JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok)
      throw new Error(`Cloudflare ${path.split("?")[0]} HTTP ${res.status}`);
    const envelope = z
      .object({ success: z.literal(true), result: z.unknown() })
      .parse(await res.json());
    return envelope.result;
  }
  const index = `vectorize/v2/indexes/${bucket}`;
  const vectors: AuditVectors = {
    list: async (cursor) =>
      z
        .object({
          vectors: z.array(z.object({ id: z.string() })),
          isTruncated: z.boolean(),
          nextCursor: z.string().nullish(),
        })
        .parse(
          await request(
            `${index}/list?count=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        ),
    get: async (ids) => {
      if (ids.length > 20) throw new Error("get_by_ids chunk exceeds 20");
      if (!ids.length) return [];
      return z
        .array(Vector)
        .parse(await request(`${index}/get_by_ids`, { ids }))
        .map(({ namespace, ...v }) => ({
          ...v,
          ...(namespace == null ? {} : { namespace }),
        }));
    },
    upsert: async (vector) => {
      z.object({ mutationId: z.string().min(1) }).parse(
        await request(`${index}/upsert`, JSON.stringify(vector) + "\n", true),
      );
    },
    delete: async (ids) => {
      z.object({ mutationId: z.string().min(1) }).parse(
        await request(`${index}/delete_by_ids`, { ids }),
      );
    },
  };
  return {
    db: controlPlaneDbForBucket(bucket),
    storage: r2InventoryClientFromVars(vars, bucket),
    vectors,
    probe: async (namespace: string) =>
      z
        .object({ matches: z.array(z.object({ id: z.string() })) })
        .parse(
          await request(`${index}/query`, {
            namespace,
            vector: [1, ...Array(1535).fill(0)],
            topK: 1,
            returnMetadata: "none",
          }),
        ).matches,
    enqueue: async (tenantId: string, force: boolean, queueId: string) => {
      // Verify identity by GET, never trust an operator-supplied id to select
      // a different environment's queue.
      const expected = `${bucket}-wipe`;
      const queue = z
        .object({ queue_name: z.string() })
        .parse(await request(`queues/${encodeURIComponent(queueId)}`));
      if (queue.queue_name !== expected)
        throw new Error(`queue must be ${expected}`);
      await request(`queues/${encodeURIComponent(queueId)}/messages`, {
        content_type: "json",
        body: { version: 1, tenantId, force },
      });
    },
  };
}
export type AccountRemote = ReturnType<typeof accountRemote>;
