/**
 * Control-plane teardown: the last stage of account deletion (issue 195 S4).
 *
 * `DELETE /api/account` fences the account (`account-delete.ts`). The queue
 * consumer wipes the data plane and writes a completion record
 * (`account-wipe.ts`, `wipe-progress.ts`). This module is what happens after
 * that: every control-plane row keyed to the tenant goes, the tenant's Durable Object
 * state goes, and the `users` row itself is hard-deleted. It is invoked from
 * the wipe cron fan-out, once per tick, for a tenant whose wipe has finished
 * and whose prefix is confirmed empty.
 *
 * ## The gate
 *
 * Teardown reads `wipe_progress.completed_at`, the CURRENT-state field, not
 * `first_completed_at`. The difference decides correctness here. A wipe that
 * finished and was then reopened because leftover objects turned up under the
 * prefix has a non-null `first_completed_at` and a NULL `completed_at`; it is running right now, and hard-deleting its `users` row
 * would strand the pass mid-flight. "Was ever done once" is the wrong question.
 * "Is done as of now" is the right one.
 *
 * Without a completion record (no row at all, or a row with a NULL
 * `completed_at`) teardown does nothing whatsoever. Not a partial pass, not
 * a best-effort subset: it returns and leaves every row where it was.
 *
 * ## Ordering
 *
 * 1. **The audit row is written first**, before a single destructive
 *    statement. If teardown crashes half-way, the durable evidence that this
 *    account's deletion was attempted, when, and how the wipe ended is already
 *    committed. Written last it would be lost in exactly the case it matters.
 * 2. **Durable Object state next**, and it fails closed. An unbound namespace
 *    holds nothing and is skipped; a bound one that errors throws here, before
 *    any row delete, so the `users` row is never removed while DO state keyed to
 *    that tenant may still be sitting in a lease book charging live tenants for
 *    concurrency. The next cron tick retries, and the audit row is already
 *    there.
 * 3. **The prefix is rechecked immediately before the final transaction**,
 *    after the guard round-trips and the address-history lookup. A late
 *    publisher in that window would otherwise leave an orphan the next cron
 *    tick can no longer enumerate, because the hard delete removes the tenant
 *    from `listDeletingUsers`.
 * 4. **The rows last, in one transaction that locks before it acts.** It locks
 *    this account's `auth_challenges` rows, then the `users` row and the
 *    `wipe_progress` row FOR UPDATE — challenges first because a login
 *    redemption takes them in that order, and the opposite order would make
 *    the two transactions a deadlock cycle. It re-asserts the
 *    gate on what it locked (still `deleting`, wipe still complete, and no
 *    `readings` row left for the tenant), and only
 *    then deletes, children before parents. D1 had no locks, so every
 *    statement of its batch carried the gate as an EXISTS guard; here the
 *    locks hold the gate still until commit, because a reopen writes the
 *    locked `wipe_progress` row and any status change writes the locked
 *    `users` row.
 *
 * ## Why the deletes are explicit, and why nothing cascades
 *
 * PostgreSQL enforces the foreign keys, and none cascades (ADR 0005), so child
 * rows are deleted before the users row. The audit row has no foreign key
 * because it must outlive the account.
 *
 * `readings` is the exception that has to be checked by hand. It names no
 * `users` row — the data plane is keyed by tenant id, not joined to the
 * control plane — so PostgreSQL would happily delete a `users` row with the
 * tenant's readings still standing, and after that nothing enumerates them.
 * Hence the count under the lock, alongside the wipe-completion re-check.
 *
 * ## Email reuse
 *
 * The `signup_invites` row is keyed by the address, not the tenant, so it is
 * deleted by the freed `email_canonical`. Until teardown runs, the address is
 * not provisionable — `resolveLoginEligibility` finds a non-active `users` row
 * and answers `ineligible`. Afterwards the row is gone and the address is free.
 * Under `invite_only`, though, "free" means free to be *invited*: the old
 * invite was deleted with everything else, so a re-signup at the same address
 * needs a fresh one. That is deliberate — leaving a consumed invite behind
 * would hand a deleted account's address a standing claim on a closed
 * system — and it is written down in `docs/operations.md` so it does not
 * surprise an operator.
 */
import type { ControlPlaneDb } from "./db";
import {
  purgeGlobalUsageLeases,
  type GlobalUsageGuardEnv,
} from "./global-usage-guard";
import { parseTenantId, type TenantId } from "./ids";
import { fromTimestamp, toTimestamp } from "./pg-time";
import {
  purgeTenantUsageGuard,
  type TenantUsageGuardEnv,
} from "./tenant-usage-guard";

export type AccountTeardownEnv = TenantUsageGuardEnv & GlobalUsageGuardEnv;

/**
 * Whether the tenant's R2 prefix is confirmed empty, asked immediately before
 * the final transaction rather than taken on trust from the caller.
 *
 * Three states, not two, on purpose. "We looked and it is empty" and "we could
 * not look" are the same `false` to the fan-out's own helper, which is
 * harmless there — it only decides whether to re-enqueue — but this is the
 * precondition for an irreversible hard delete, and a "cannot determine" that
 * reads as "confirmed clean" is exactly the shape that loses data.
 */
export type PrefixVerdict = "empty" | "not_empty" | "unknown";

export type AccountTeardownResult =
  /** The account is gone: audit row written, DO state cleared, rows deleted. */
  | { kind: "torn_down"; tenantId: string; rowsDeleted: number }
  /** An audit row already exists and the `users` row is already gone. */
  | { kind: "already_torn_down" }
  /** No `users` row and no audit row: nothing here to tear down. */
  | { kind: "not_found" }
  /** The account is not in the deletion pipeline. Never tear down a live one. */
  | { kind: "not_deleting"; status: string }
  /** No completion record, or a reopened wipe. The gate refused. */
  | { kind: "wipe_incomplete" }
  /** Objects remain under the tenant prefix, or we could not confirm. */
  | { kind: "prefix_not_empty"; verdict: PrefixVerdict }
  /**
 * The account left `deleting` between the status read and the final
 * transaction. Nothing was deleted: the locked re-check refused.
   */
  | { kind: "reactivated" }
  /**
 * A concurrent tick reopened the wipe between the gate read and the final
 * transaction. Same story: nothing was deleted.
   */
  | { kind: "wipe_reopened" }
  /**
   * Reading rows or inbox items the tenant still owns, seen under the lock.
   * Nothing was deleted: neither table has a foreign key to `users`, so
   * dropping the users row would orphan them beyond any tenant-keyed recovery.
   */
  | { kind: "rows_remain"; remaining: number };

interface UserRow {
  email_canonical: string;
  status: string;
  deleting_at: string | null;
}

interface CompletionRow {
  completed_at: string | null;
  residue: boolean;
  first_completed_at: string | null;
  first_residue: boolean;
}

/**
 * Tear down one tenant's control plane.
 *
 * Idempotent and independently resumable: safe to call on a tenant that has
 * already been torn down, on one whose wipe has not finished, and on one that
 * never existed. Each of those is a distinct, non-destructive result rather
 * than a throw, because the caller is a cron tick that will come back in
 * fifteen minutes either way.
 *
 * Throws only when a step that must not be skipped could not be completed: a
 * bound Durable Object namespace that errored, or a failing database write. The
 * caller logs and moves on to the next tenant; the next tick retries this one.
 */
export async function tearDownAccount(
  db: ControlPlaneDb,
  env: AccountTeardownEnv,
  input: {
    tenantId: string;
    nowMs: number;
    /**
     * Asks, immediately before the final transaction, whether the tenant's R2 prefix is
     * still holding objects. Required: this module enforces its own
     * precondition rather than trusting a caller that checked earlier, because
     * the check the caller made happened before two Durable Object round-trips
     * and the address-history lookup, and because the hard delete removes the
     * tenant from `listDeletingUsers`, retiring the leftover-reopen net that
     * used to cover exactly this.
     */
    prefixVerdict: () => Promise<PrefixVerdict>;
  },
): Promise<AccountTeardownResult> {
  const tenantId = parseTenantId(input.tenantId);
  if (!tenantId) return { kind: "not_found" };

  const user = await db.first<UserRow>(
    "SELECT email_canonical, status, deleting_at FROM users WHERE id = ?",
    tenantId,
  );
  if (!user) {
    // No user row. Either this account was already torn down — in which case
    // the audit row proves it and there is nothing left to do — or it never
    // existed. Distinguishing the two costs one read and makes the caller's
    // logs mean something.
    const audited = await db.first<{ tenant_id: string }>(
      "SELECT tenant_id FROM account_deletions WHERE tenant_id = ?",
      tenantId,
    );
    return audited ? { kind: "already_torn_down" } : { kind: "not_found" };
  }
  if (user.status !== "deleting") return { kind: "not_deleting", status: user.status };

  const completion = await db.first<CompletionRow>(
    `SELECT completed_at, residue, first_completed_at, first_residue
       FROM wipe_progress WHERE tenant_id = ?`,
    tenantId,
  );
  // The gate. A missing row means the wipe never ran; a NULL `completed_at`
  // means it is running now, including the reopened-after-leftovers case that
  // `first_completed_at` would wrongly wave through.
  if (!completion || completion.completed_at === null) return { kind: "wipe_incomplete" };

  // (1) Evidence before destruction.
  await writeAuditRow(db, {
    tenantId,
    deletingAtMs: fromTimestamp(user.deleting_at),
    completedAtMs: fromTimestamp(completion.completed_at),
    residue: completion.residue,
    firstCompletedAtMs: fromTimestamp(completion.first_completed_at),
    firstResidue: completion.first_residue,
    nowMs: input.nowMs,
  });

  // (2) Durable Object state, fail-closed: a throw here leaves every row in
  // place for the next tick, with the audit row already committed.
  await purgeTenantUsageGuard(env, tenantId);
  await purgeGlobalUsageLeases(env, tenantId);

  // (3) Prefix recheck, immediately before the final transaction.
  //
  // The addresses are collected first, because the transaction is what
  // deletes the rows that name them. The prefix is rechecked AFTER that lookup
  // and the guard round-trips: a late publisher during either window would
  // otherwise leave an orphaned object after the users row is gone, and cron
  // would stop enumerating the tenant.
  const addresses = await addressesEverUsed(db, tenantId, user.email_canonical);
  // The data-plane half has to be confirmed gone, here, now. Anything but a
  // positive "empty" refuses — including "we could not look", because objects
  // orphaned by this delete can never be found again through the tenant.
  const verdict = await input.prefixVerdict();
  if (verdict !== "empty") return { kind: "prefix_not_empty", verdict };

  // (4) The rows, in one transaction that locks, re-checks, then deletes.
  return db.transaction(async (tx) => {
    // Challenges before the user row, because that is the order a login takes:
    // `redeemLoginChallenge` locks the challenge and only then locks `users`
    // (`issueSessionForClaim`). Locking `users` first here would make the two
    // transactions a cycle, and PostgreSQL would resolve it by aborting one of
    // them — a login or this teardown, at random. `ORDER BY id` keeps two
    // teardowns from doing the same to each other.
    const challenges = accountChallenges(tenantId, addresses[0]!);
    await tx.all(`SELECT id FROM ${challenges.from} ORDER BY id FOR UPDATE`, ...challenges.params);
    const locked = await tx.first<{ status: string }>("SELECT status FROM users WHERE id = ? FOR UPDATE", tenantId);
    // Another delivery got there first and finished the job.
    if (!locked) return { kind: "already_torn_down" };
    if (locked.status !== "deleting") return { kind: "reactivated" };
    const wipe = await tx.first<{ completed_at: string | null }>(
      "SELECT completed_at FROM wipe_progress WHERE tenant_id = ? FOR UPDATE",
      tenantId,
    );
    if (!wipe || wipe.completed_at === null) return { kind: "wipe_reopened" };
    // The wipe's own completion guard already asserted this, but that was
    // before this transaction took its locks, and neither `readings` nor
    // `inbox_items` names a `users` row for PostgreSQL to refuse the delete
    // over (ADR 0005, db/migrations/0008). Asked here, under the lock, it is
    // the last moment the answer can still be acted on: afterwards the tenant
    // is gone from `listDeletingUsers` and nothing enumerates those rows again.
    //
    // The `users` lock above is what makes the count hold through the commit;
    // this statement takes no lock of its own. `claimUrl` and inbox stage, the
    // only live inserters of these rows, take `users` FOR SHARE in the same
    // transaction as their insert: one already in flight blocks that FOR
    // UPDATE until it commits, so this count sees its row and answers
    // `rows_remain`; one arriving later blocks until this transaction commits
    // and then finds no active `users` row. The same fence is why teardown's
    // statements below need no delete for either table: it could only ever
    // delete nothing. Unlike the prefix verdict above, which is taken before
    // the lock, this one cannot be raced.
    const remaining = await countTenantDataRows(tx, tenantId);
    // Fail closed, like the prefix verdict above. `count(*)` always returns a
    // row, so a missing one means the seam is broken rather than that the
    // tenant is clean — and this is the one question teardown must not guess
    // at, because the delete it gates is irreversible. Throwing leaves every
    // row in place for the next tick, which is what the caller expects.
    if (remaining === null) throw new Error(`account_teardown could not count reading rows for ${tenantId}`);
    if (remaining > 0) return { kind: "rows_remain", remaining };
    let rowsDeleted = 0;
    for (const statement of teardownStatements(tenantId, addresses)) {
      rowsDeleted += (await tx.run(statement.sql, ...statement.params)).changes;
    }
    return { kind: "torn_down", tenantId, rowsDeleted };
  });
}

/**
 * The tenant rows teardown refuses over (`rows_remain`): reading rows and
 * inbox items, neither of which names a `users` row (ADR 0005,
 * db/migrations/0008). Single-homed because three callers ask it — the wipe's
 * completion guard, the wipe's reopen check and teardown's under-lock count —
 * and a table counted by one but not the others either records a completion
 * teardown refuses, or bounces the tenant between teardown and fan-out
 * forever. Null when the count could not be read; each caller fails closed.
 */
export async function countTenantDataRows(db: ControlPlaneDb, tenantId: string): Promise<number | null> {
  const row = await db.first<{ remaining: number }>(
    `SELECT (SELECT count(*) FROM readings WHERE tenant_id = ?)
          + (SELECT count(*) FROM inbox_items WHERE tenant_id = ?) AS remaining`,
    tenantId,
    tenantId,
  );
  return row ? row.remaining : null;
}

/**
 * The audit row, upserted.
 *
 * A retry after a crash refreshes what the wipe reported (a reopened and
 * re-completed wipe can land a later `completed_at`) but never moves
 * `torn_down_at`, which records the first
 * attempt. That first stamp is the evidence; overwriting it on every retry
 * would quietly rewrite when the account's deletion actually began to happen.
 */
async function writeAuditRow(
  db: ControlPlaneDb,
  input: {
    tenantId: TenantId;
    deletingAtMs: number | null;
    completedAtMs: number | null;
    residue: boolean;
    firstCompletedAtMs: number | null;
    firstResidue: boolean;
    nowMs: number;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO account_deletions (
       tenant_id, deleting_at, completed_at, residue,
       first_completed_at, first_residue, torn_down_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       deleting_at = excluded.deleting_at,
       completed_at = excluded.completed_at,
       residue = excluded.residue,
       first_completed_at = excluded.first_completed_at,
       first_residue = excluded.first_residue`,
    input.tenantId,
    toTimestamp(input.deletingAtMs),
    toTimestamp(input.completedAtMs),
    input.residue,
    toTimestamp(input.firstCompletedAtMs),
    input.firstResidue,
    toTimestamp(input.nowMs),
  );
}

/**
 * Every address this account ever authenticated at, current one included.
 *
 * `signup_invites` is keyed by address, not by tenant, and `users` remembers
 * only the current address — so deleting by that alone leaves the invite row
 * for any previous address behind. That row keeps the old `email_display` of a
 * deleted account, and being `consumed` it permanently blocks re-signup at an
 * address whose account no longer exists.
 *
 * `auth_challenges` is the only link back — but only two of its shapes actually
 * PROVE ownership, and picking the wrong ones here is a cross-account hole
 * rather than a tidiness bug:
 *
 * - `completed_user_id = ?` is set when a challenge was successfully redeemed.
 *   Redemption is the proof.
 * - `user_id = ? AND purpose = 'login'` is set by `issueLoginChallenge` from
 *   `resolveLoginEligibility`, which returns a user only when that user already
 *   owns the address.
 *
 * Deliberately EXCLUDED: `user_id = ?` on an `email_change` challenge.
 * `issueEmailChangeChallenge` stores the requester's `user_id` alongside the
 * *requested target* address, and nothing verifies the requester owns it until
 * the challenge is redeemed. Collecting those would let any authenticated user
 * name a stranger's address, delete their own account, and have teardown
 * destroy that stranger's outstanding `signup_invites` row — silently blocking
 * their signup under `invite_only`. An unredeemed, expired or revoked row is
 * enough to do it, so this is reachable on purpose, not just by accident.
 *
 * Read before the final transaction, because it deletes those very rows.
 */
async function addressesEverUsed(
  db: ControlPlaneDb,
  tenantId: TenantId,
  currentEmail: string,
): Promise<string[]> {
  const rows = await db.all<{ email_canonical: string }>(
    `SELECT DISTINCT email_canonical FROM auth_challenges
      WHERE completed_user_id = ? OR (user_id = ? AND purpose = 'login')`,
    tenantId,
    tenantId,
  );
  // The current address may have no surviving challenge at all, so it is added
  // rather than assumed present.
  return [...new Set([currentEmail, ...rows.map((row) => row.email_canonical)])];
}

/**
 * The `auth_challenges` rows this account owns: one predicate, used twice —
 * to lock the rows at the top of the final transaction and to delete them
 * inside it. They must stay identical, or the lock would miss a row the delete
 * still takes, which is the deadlock the lock exists to prevent.
 *
 * Three arms, and each one catches rows the others miss. Nothing else
 * ever deletes from `auth_challenges` (there is no TTL prune), so a row
 * missed here is a permanent record of a deleted account's address.
 *
 * One shape is knowingly missed: a login challenge that was issued and
 * then superseded at signup, on an address the account has since changed
 * away from. It has `user_id IS NULL` and `completed_user_id IS NULL`, so
 * no arm reaches it. It is not swept by address because, on a *released*
 * address, a NULL-owner row may equally belong to somebody signing up
 * there now, and deleting theirs is the worse error.
 *
 * `user_id` is this account's own challenges, including an `email_change`
 * aimed at some other address. `completed_user_id` is the signup
 * challenge that created the account. The NULL-owner arm frees the
 * `auth_challenges_one_issued` slot for the released address, and is
 * bound to the CURRENT address only: while a live user owns an address,
 * a login challenge for it carries that user's id, never NULL, so on the
 * current address no such row can be anyone else's.
 *
 * Deliberately NOT "every row matching the address": that would also
 * destroy a different, live user's in-flight `email_change` challenge
 * targeting it.
 */
function accountChallenges(
  tenantId: TenantId,
  emailCanonical: string,
): { from: string; params: unknown[] } {
  return {
    from: `auth_challenges
             WHERE user_id = ?
                OR completed_user_id = ?
                OR (email_canonical = ? AND user_id IS NULL)`,
    params: [tenantId, tenantId, emailCanonical],
  };
}

/**
 * Account-owned control-plane rows, children before parents. Run inside the
 * final transaction, after it has locked and re-checked the gate.
 *
 * Order follows the foreign keys: `api_token_scopes` is reachable only through
 * `api_tokens`, so it goes first; `wipe_progress` goes before `users`; and
 * `users` goes last because everything above names it.
 *
 * `auth_challenges` is deleted by user id **and** by address: an
 * `email_change` challenge points at the user while carrying a different
 * address, and a `login` challenge issued before the account existed carries
 * the address with a NULL user id. Both hold `email_canonical`/`email_display`,
 * which is exactly what a deletion request is about, and a leftover `issued`
 * row would also occupy the `auth_challenges_one_issued` slot for an address
 * that is supposed to be free.
 *
 * `signup_invites` has no tenant column at all, so it is the one delete driven
 * by address rather than by id, and by *every* address this account ever used,
 * not only its current one. See `addressesEverUsed`.
 *
 * These stores are deliberately retained:
 *
 * - `AuthRateGuard` (a Durable Object, not a table) is a singleton of hashed,
 *   TTL-windowed email/IP counters with no tenant key to purge by.
 * - `dev_mail_outbox` holds `to_email` and magic-link URLs, but it is the
 *   local-only sink: `LOCAL_MAIL_SINK` is never enabled on staging or
 *   production, so the table is empty in every environment an account can
 *   actually be deleted in.
 *
 * The audit row and both Durable Object purges have already run by the time
 * the transaction can refuse. A reactivated account therefore comes back with
 * its rows intact but its usage guard emptied and a standing
 * `account_deletions` row. So an audit row is evidence that teardown was
 * *attempted*, never on its own that an account was deleted; the absence of
 * the `users` row is what says that. No code path moves a row from `deleting`
 * back to `active` today, so this is a defensive guarantee.
 */
function teardownStatements(
  tenantId: TenantId,
  addresses: string[],
): Array<{ sql: string; params: unknown[] }> {
  // The account's current address is always first (see `addressesEverUsed`).
  const emailCanonical = addresses[0]!;
  const challenges = accountChallenges(tenantId, emailCanonical);
  return [
    {
      sql: `DELETE FROM api_token_scopes
             WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)`,
      params: [tenantId],
    },
    { sql: "DELETE FROM api_tokens WHERE user_id = ?", params: [tenantId] },
    { sql: "DELETE FROM sessions WHERE user_id = ?", params: [tenantId] },
    {
      // The predicate, and why it has three arms, is `accountChallenges`.
      sql: `DELETE FROM ${challenges.from}`,
      params: challenges.params,
    },
    { sql: "DELETE FROM digest_deliveries WHERE user_id = ?", params: [tenantId] },
    { sql: "DELETE FROM relationship_refresh_jobs WHERE tenant_id = ?", params: [tenantId] },
    { sql: "DELETE FROM user_settings WHERE user_id = ?", params: [tenantId] },
    { sql: "DELETE FROM tenant_limits WHERE tenant_id = ?", params: [tenantId] },
    // The operator refresh pass's run marker (db/migrations/0006). It names
    // this tenant's reading ids, so it is tenant data, and no tenant is exempt
    // from deletion. A row left behind would also hand the next
    // `corpus refresh-neighbours` a marker listing readings that no longer
    // exist, which it reads as purges and answers with a sweep.
    { sql: "DELETE FROM corpus_refresh_state WHERE tenant_id = ?", params: [tenantId] },
    // Every address the account ever used, not just its last one: an invite
    // row for a previous address would otherwise outlive the account, carrying
    // its old `email_display` and blocking re-signup there forever.
    //
    // `consumed_at IS NOT NULL` keeps teardown out of somebody else's account.
    // An address this account released can have been re-invited to someone
    // else since; that invite is UNCONSUMED, a pending grant, and must
    // survive. This account's own invite was spent at signup, so it goes.
    //
    // The current address is the exception, because an account that moved to
    // an address by email change owns it with any invite there still
    // unconsumed (`completeEmailChange` never touches `signup_invites`). That
    // invite names the address this teardown is releasing, not a third
    // party's grant.
    {
      sql: `DELETE FROM signup_invites
             WHERE email_canonical = ANY (?::text[])
               AND (consumed_at IS NOT NULL OR email_canonical = ?)`,
      params: [addresses, emailCanonical],
    },
    // No cascade (db/migrations/0007). The row has to go before the user or
    // teardown cannot finish for a tenant that requested an export.
    // beginAccountDeletion already cancelled any active one, and the wipe
    // swept its parts with the tenant prefix.
    { sql: "DELETE FROM archive_exports WHERE tenant_id = ?", params: [tenantId] },
    { sql: "DELETE FROM wipe_progress WHERE tenant_id = ?", params: [tenantId] },
    // Last: everything above names it.
    { sql: "DELETE FROM users WHERE id = ?", params: [tenantId] },
  ];
}
