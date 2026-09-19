/** Latest-run idempotency and recovery checkpoint; older jobs cannot overwrite it.
 * Claim only after paid admission, immediately before the provider call. A null
 * result is not retried by another delivery unless a confirmed 429 recorded
 * retry_at. Unknown charges remain held in the spend authority.
 *
 * run_at is timestamptz and comes back through the seam as ISO-8601 UTC with
 * milliseconds, the same spelling the judge builds with toISOString(), so the
 * judge's string comparisons still compare instants.
 */
import { z } from "zod";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";
import { sha256Hex } from "../services";
import { ManifestSchema, type Manifest } from "../schemas/manifest";

const ResultSchema = z.object({
  // Store only the fields refresh owns, not another copy of the article.
  patch: z.object({
    connections: ManifestSchema.shape.connections.unwrap(),
    novelty_verdict: ManifestSchema.shape.novelty_verdict.unwrap(),
    connections_computed_at: z.string().datetime(),
    connections_neighbourhood_ids: z.array(z.string().min(1)),
  }).strict(),
  neighbour_versions: z.array(z.object({ id: z.string().min(1), key_prefix: z.string().startsWith("readings/"), etag: z.string().min(1) })),
  manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SavedRefreshResult = z.infer<typeof ResultSchema>;
const RowSchema = z.object({ run_at: z.string().datetime(), owner: z.string(), source_etag: z.string().min(1), result_json: z.unknown(), retry_at: z.string().datetime().nullable() });
export async function readRefreshJob(db: ControlPlaneDb, tenantId: string, readingId: string) {
  const raw = await db.first("SELECT run_at, owner, source_etag, result_json, retry_at FROM relationship_refresh_jobs WHERE tenant_id = ? AND reading_id = ?", tenantId, readingId);
  if (!raw) return null;
  const { retry_at, result_json, ...row } = RowSchema.parse(raw);
  const result = result_json == null ? null : ResultSchema.parse(result_json);
  return { ...row, retry_at_ms: fromTimestamp(retry_at), result };
}
export async function markRefreshDispatched(db: ControlPlaneDb, input: { tenantId: string; readingId: string; runAt: string; owner: string; sourceEtag: string }): Promise<boolean> {
  const { changes } = await db.run(`INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag)
    SELECT id, ?, ?, ?, ? FROM users WHERE id = ? AND status = 'active'
    ON CONFLICT(tenant_id, reading_id) DO UPDATE SET run_at = excluded.run_at, owner = excluded.owner, source_etag = excluded.source_etag, result_json = NULL, retry_at = NULL
    WHERE relationship_refresh_jobs.run_at < excluded.run_at
       OR (relationship_refresh_jobs.run_at = excluded.run_at AND relationship_refresh_jobs.owner = excluded.owner AND relationship_refresh_jobs.source_etag = excluded.source_etag AND relationship_refresh_jobs.result_json IS NULL)
       OR (relationship_refresh_jobs.run_at = excluded.run_at AND relationship_refresh_jobs.result_json IS NULL AND relationship_refresh_jobs.retry_at <= ?)`,
  input.readingId, toTimestamp(Date.parse(input.runAt)), input.owner, input.sourceEtag, input.tenantId, toTimestamp(Date.now()));
  return changes === 1;
}
export async function saveRefreshResult(db: ControlPlaneDb, tenantId: string, readingId: string, owner: string, manifest: Manifest, neighbourVersions: SavedRefreshResult["neighbour_versions"]): Promise<SavedRefreshResult | null> {
  const m = ManifestSchema.parse(manifest);
  const result = ResultSchema.parse({
    patch: { connections: m.connections, novelty_verdict: m.novelty_verdict,
      connections_computed_at: m.connections_computed_at, connections_neighbourhood_ids: m.connections_neighbourhood_ids },
    neighbour_versions: neighbourVersions,
    manifest_hash: await sha256Hex(JSON.stringify(m)),
  });
  const written = await db.run(`UPDATE relationship_refresh_jobs SET result_json = ? WHERE tenant_id = ? AND reading_id = ? AND owner = ?
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')`,
  JSON.stringify(result), tenantId, readingId, owner, tenantId);
  return written.changes === 1 ? result : null;
}
export async function markRefreshRateLimited(db: ControlPlaneDb, tenantId: string, readingId: string, owner: string, retryAtMs: number): Promise<void> {
  await db.run(`UPDATE relationship_refresh_jobs SET retry_at = ?
    WHERE tenant_id = ? AND reading_id = ? AND owner = ? AND result_json IS NULL`, toTimestamp(retryAtMs), tenantId, readingId, owner);
}
export async function deleteRefreshJob(db: ControlPlaneDb, tenantId: string, readingId: string): Promise<void> {
  await db.run("DELETE FROM relationship_refresh_jobs WHERE tenant_id = ? AND reading_id = ?", tenantId, readingId);
}
