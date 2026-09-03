import { revokeAllApiTokensForUser } from "./authenticate";
import type { ControlPlaneDb } from "./db";
import { parseUserId } from "./ids";
import { revokeAllSessionsForUser } from "./sessions";

// Account-deletion suppress (issue 195a / s1k.10.1). Marks the user `deleting`
// and revokes credentials so queued, retry, digest, and notification paths
// cannot resurrect data. Wipe, residue scan, and email reuse are 195b — this
// module does not delete R2, Vectorize, Durable Objects, or D1 rows, and does
// not invent GlobalUsageGuard teardown (s1k.9.2).
//
// `DELETE /api/account` is not `DELETE /api/readings/:id`. The latter purges
// one reading inside a live tenant; this path fences the whole tenant.
//
// Production `TENANT_DATA_PLANE=1`: the founder is a normal tenant. Deleting
// the founder account suppresses `u/{founderTenantId}/` the same way as any
// other tenant. Do not special-case the founder silently.
//
// Ordering is the fence: `users.status = deleting` is committed BEFORE session
// and token revocation. A crash after the status write still 403s authenticate
// (`status !== "active"`) and admitEnvelope (`tenant_inactive`). In-flight
// `processReading` that already passed admit rechecks status immediately
// before visibility publish (the #179 republish race, at tenant scope).

export type BeginAccountDeletionResult =
  | { kind: "started" }
  | { kind: "already_deleting" }
  | { kind: "not_found" }
  | { kind: "not_active" };

export const ACCOUNT_DELETE_REVOCATION_REASON = "account_delete";

// Confirmed inactive: a row with status !== "active", or a confirmed missing
// user (null row). Lookup failure (D1 throw/timeout) must not be treated as
// inactive — callers that fence spend/visibility wrap that throw as a
// RateLimitedError so the queue retries.
export async function tenantIsActive(db: ControlPlaneDb, tenantId: string): Promise<boolean> {
  const row = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", tenantId);
  return row?.status === "active";
}

export async function beginAccountDeletion(
  db: ControlPlaneDb,
  input: { userId: string; nowMs: number },
): Promise<BeginAccountDeletionResult> {
  const userId = parseUserId(input.userId);
  if (!userId) return { kind: "not_found" };

  const user = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", userId);
  if (!user) return { kind: "not_found" };
  if (user.status === "deleting") {
    await revokeCredentials(db, { userId, nowMs: input.nowMs });
    return { kind: "already_deleting" };
  }
  if (user.status !== "active") return { kind: "not_active" };

  // Status write is the durable fence. Keep it a standalone statement so a
  // later revoke failure cannot roll the mark back.
  const marked = await db.run(
    `UPDATE users
     SET status = 'deleting',
         deleting_at_ms = COALESCE(deleting_at_ms, ?),
         updated_at_ms = ?
     WHERE id = ? AND status = 'active'`,
    input.nowMs,
    input.nowMs,
    userId,
  );
  if (marked.changes === 0) {
    const again = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", userId);
    if (again?.status === "deleting") {
      await revokeCredentials(db, { userId, nowMs: input.nowMs });
      return { kind: "already_deleting" };
    }
    return { kind: "not_active" };
  }

  await revokeCredentials(db, { userId, nowMs: input.nowMs });
  return { kind: "started" };
}

async function revokeCredentials(
  db: ControlPlaneDb,
  input: { userId: string; nowMs: number },
): Promise<void> {
  const userId = parseUserId(input.userId);
  if (!userId) return;
  await revokeAllSessionsForUser(db, {
    userId,
    nowMs: input.nowMs,
    reason: ACCOUNT_DELETE_REVOCATION_REASON,
  });
  await revokeAllApiTokensForUser(db, { userId, nowMs: input.nowMs });
}
