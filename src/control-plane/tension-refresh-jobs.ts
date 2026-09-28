/** Latest-run idempotency and recovery checkpoint for one tension pair, the
 * pairwise sibling of relationship-refresh-jobs.ts with the same rules: claim
 * only after paid admission, immediately before the provider call; a null
 * result is not retried by another delivery unless a confirmed 429 recorded
 * retry_at; older runs cannot overwrite a newer one. Unknown charges remain
 * held in the spend authority.
 *
 * A pair is always stored canonically (`a < b`). The saved result is the
 * judgement itself plus the hash of each manifest it produced, so a replay can
 * rebuild the same two writes without another provider call and recognise
 * them once committed.
 */
import { z } from "zod";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";
import { TensionJudgementSchema } from "../schemas/reading-summary";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ResultSchema = z.object({
  judgement: TensionJudgementSchema,
  computed_at: z.string().datetime(),
  a_hash: Hash,
  b_hash: Hash,
}).strict();
export type SavedTensionResult = z.infer<typeof ResultSchema>;
export interface TensionPairKey { tenantId: string; a: string; b: string }

const RowSchema = z.object({
  run_at: z.string().datetime(), owner: z.string(), a_version: z.string().min(1), b_version: z.string().min(1),
  result_json: z.unknown(), retry_at: z.string().datetime().nullable(),
});
export async function readTensionJob(db: ControlPlaneDb, key: TensionPairKey) {
  const raw = await db.first(
    "SELECT run_at, owner, a_version, b_version, result_json, retry_at FROM tension_refresh_jobs WHERE tenant_id = ? AND reading_a = ? AND reading_b = ?",
    key.tenantId, key.a, key.b,
  );
  if (!raw) return null;
  const { retry_at, result_json, ...row } = RowSchema.parse(raw);
  const result = result_json == null ? null : ResultSchema.parse(result_json);
  return { ...row, retry_at_ms: fromTimestamp(retry_at), result };
}
export async function markTensionDispatched(db: ControlPlaneDb, input: TensionPairKey & { runAt: string; owner: string; aVersion: string; bVersion: string }): Promise<boolean> {
  const { changes } = await db.run(`INSERT INTO tension_refresh_jobs (tenant_id, reading_a, reading_b, run_at, owner, a_version, b_version)
    SELECT id, ?, ?, ?, ?, ?, ? FROM users WHERE id = ? AND status = 'active'
    ON CONFLICT(tenant_id, reading_a, reading_b) DO UPDATE SET run_at = excluded.run_at, owner = excluded.owner,
      a_version = excluded.a_version, b_version = excluded.b_version, result_json = NULL, retry_at = NULL
    WHERE tension_refresh_jobs.run_at < excluded.run_at
       OR (tension_refresh_jobs.run_at = excluded.run_at AND tension_refresh_jobs.owner = excluded.owner
           AND tension_refresh_jobs.a_version = excluded.a_version AND tension_refresh_jobs.b_version = excluded.b_version
           AND tension_refresh_jobs.result_json IS NULL)
       OR (tension_refresh_jobs.run_at = excluded.run_at AND tension_refresh_jobs.result_json IS NULL AND tension_refresh_jobs.retry_at <= ?)`,
  input.a, input.b, toTimestamp(Date.parse(input.runAt)), input.owner, input.aVersion, input.bVersion, input.tenantId, toTimestamp(Date.now()));
  return changes === 1;
}
export async function saveTensionResult(db: ControlPlaneDb, key: TensionPairKey, owner: string, result: SavedTensionResult): Promise<SavedTensionResult | null> {
  const parsed = ResultSchema.parse(result);
  const written = await db.run(`UPDATE tension_refresh_jobs SET result_json = ?
    WHERE tenant_id = ? AND reading_a = ? AND reading_b = ? AND owner = ?
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')`,
  JSON.stringify(parsed), key.tenantId, key.a, key.b, owner, key.tenantId);
  return written.changes === 1 ? parsed : null;
}
export async function markTensionRateLimited(db: ControlPlaneDb, key: TensionPairKey, owner: string, retryAtMs: number): Promise<void> {
  await db.run(`UPDATE tension_refresh_jobs SET retry_at = ?
    WHERE tenant_id = ? AND reading_a = ? AND reading_b = ? AND owner = ? AND result_json IS NULL`,
  toTimestamp(retryAtMs), key.tenantId, key.a, key.b, owner);
}
export async function releaseTensionClaim(db: ControlPlaneDb, key: TensionPairKey, owner: string): Promise<void> {
  await db.run("DELETE FROM tension_refresh_jobs WHERE tenant_id = ? AND reading_a = ? AND reading_b = ? AND owner = ?",
    key.tenantId, key.a, key.b, owner);
}
