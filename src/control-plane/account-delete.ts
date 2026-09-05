import { revokeAllApiTokensForUser } from "./authenticate";
import type { ControlPlaneDb } from "./db";
import { parseUserId } from "./ids";
import { revokeAllSessionsForUser } from "./sessions";

// Account-deletion suppress (issue 195a / s1k.10.1). Marks the user `deleting`
// and revokes credentials so queued, retry, digest, and notification paths
// cannot resurrect data. R2+Vectorize wipe is 195b via a shared queue + cron,
// never inline here, and neither is anything downstream of it. The users-row
// hard-delete, the Durable Object teardown (this tenant's `TenantUsageGuard`
// and its `GlobalUsageGuard` leases) and email reuse all live in
// `src/control-plane/account-teardown.ts` (issue 195 S4), which the wipe cron
// fan-out runs once the wipe has completed and the tenant prefix is confirmed
// empty. The residue scan is still a later slice (S5). This module's job stops
// at the fence.
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
// inactive. The pre-spend gate wraps that throw as RateLimitedError so the
// queue retries; post-CAS publish and the DLQ mark path fail-open instead.
export async function tenantIsActive(db: ControlPlaneDb, tenantId: string): Promise<boolean> {
  const row = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", tenantId);
  return row?.status === "active";
}

// Confirmed `deleting`: this account is in the deletion pipeline, so an account
// wipe may be concurrently removing its list index, manifests, and objects.
// Strictly narrower than `!tenantIsActive`, which is also true for `suspended`
// and for a confirmed-missing row — neither of which runs a wipe, and neither of
// which justifies the ungated vector delete the publisher-side deletion fence
// performs. A lookup failure is not a confirmation and must not be read as one.
export async function tenantIsDeleting(db: ControlPlaneDb, tenantId: string): Promise<boolean> {
  const row = await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", tenantId);
  return row?.status === "deleting";
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
