/**
 * Control-plane teardown: the last stage of account deletion (issue 195 S4).
 *
 * `DELETE /api/account` fences the account (`account-delete.ts`). The queue
 * consumer wipes the data plane and writes a completion record
 * (`account-wipe.ts`, `wipe-progress.ts`). This module is what happens after
 * that: every D1 row keyed to the tenant goes, the tenant's Durable Object
 * state goes, and the `users` row itself is hard-deleted. It is invoked from
 * the wipe cron fan-out, once per tick, for a tenant whose wipe has finished
 * and whose prefix is confirmed empty.
 *
 * ## The gate
 *
 * Teardown reads `wipe_progress.completed_at_ms` — the CURRENT-state field,
 * not `first_completed_at_ms`. The difference decides correctness here. A wipe
 * that finished and was then reopened because leftover objects turned up under
 * the prefix has a non-null `first_completed_at_ms` and a NULL
 * `completed_at_ms`; it is running right now, and hard-deleting its `users` row
 * would strand the pass mid-flight. "Was ever done once" is the wrong question.
 * "Is done as of now" is the right one.
 *
 * Without a completion record — no row at all, or a row with a NULL
 * `completed_at_ms` — teardown does nothing whatsoever. Not a partial pass, not
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
 *    any D1 delete, so the `users` row is never removed while DO state keyed to
 *    that tenant may still be sitting in a lease book charging live tenants for
 *    concurrency. The next cron tick retries, and the audit row is already
 *    there.
 * 3. **The D1 rows last, in one `db.batch([...])`** — children before parents,
 *    `wipe_progress` before `users`.
 *
 * ## Why the deletes are explicit, and why nothing cascades
 *
 * No migration in this schema declares `ON DELETE CASCADE`, and none sets
 * `PRAGMA foreign_keys = ON` either, so a `REFERENCES` clause here is a
 * statement of meaning rather than an enforced rule. Ordering is therefore this
 * module's job, not the database's. That is not a workaround: a cascade from
 * `users` would take `wipe_progress` with it, destroying the completion record
 * at the instant teardown reads it to decide it may act (design decision E).
 * The `account_deletions` audit row goes further and carries no foreign key at
 * all, because it has to outlive the row it describes.
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
import type { ControlPlaneDb, SqlStatement } from "./db";
import {
  purgeGlobalUsageLeases,
  type GlobalUsageGuardEnv,
} from "./global-usage-guard";
import { parseTenantId, type TenantId } from "./ids";
import {
  purgeTenantUsageGuard,
  type TenantUsageGuardEnv,
} from "./tenant-usage-guard";

export type AccountTeardownEnv = TenantUsageGuardEnv & GlobalUsageGuardEnv;

/**
 * Whether the tenant's R2 prefix is confirmed empty, asked at the moment of
 * the delete rather than taken on trust from the caller.
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
   * The account left `deleting` between the status read and the batch, so the
   * whole batch matched nothing. Nothing was deleted — the guard held.
   */
  | { kind: "reactivated" }
  /**
   * A concurrent tick reopened the wipe between the gate read and the batch.
   * Same story: the guard held and nothing was deleted.
   */
  | { kind: "wipe_reopened" };

interface UserRow {
  email_canonical: string;
  status: string;
  deleting_at_ms: number | null;
}

interface CompletionRow {
  completed_at_ms: number | null;
  residue: number;
  first_completed_at_ms: number | null;
  first_residue: number;
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
 * Throws only when a step that must not be skipped could not be completed — a
 * bound Durable Object namespace that errored, or a failing D1 batch. The
 * caller logs and moves on to the next tenant; the next tick retries this one.
 */
export async function tearDownAccount(
  db: ControlPlaneDb,
  env: AccountTeardownEnv,
  input: {
    tenantId: string;
    nowMs: number;
    /**
     * Asks, at the moment of the delete, whether the tenant's R2 prefix is
     * still holding objects. Required: this module enforces its own
     * precondition rather than trusting a caller that checked earlier, because
     * the check the caller made happened before two Durable Object round-trips
     * and because the hard delete removes the tenant from `listDeletingUsers`,
     * retiring the leftover-reopen net that used to cover exactly this.
     */
    prefixVerdict: () => Promise<PrefixVerdict>;
  },
): Promise<AccountTeardownResult> {
  const tenantId = parseTenantId(input.tenantId);
  if (!tenantId) return { kind: "not_found" };

  const user = await db.first<UserRow>(
    "SELECT email_canonical, status, deleting_at_ms FROM users WHERE id = ?",
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
    `SELECT completed_at_ms, residue, first_completed_at_ms, first_residue
       FROM wipe_progress WHERE tenant_id = ?`,
    tenantId,
  );
  // The gate. A missing row means the wipe never ran; a NULL `completed_at_ms`
  // means it is running now, including the reopened-after-leftovers case that
  // `first_completed_at_ms` would wrongly wave through.
  if (!completion || completion.completed_at_ms === null) return { kind: "wipe_incomplete" };
  const completedAtMs = completion.completed_at_ms;

  // The data-plane half has to be confirmed gone, here, now. Anything but a
  // positive "empty" refuses — including "we could not look", because objects
  // orphaned by this delete can never be found again through the tenant.
  const verdict = await input.prefixVerdict();
  if (verdict !== "empty") return { kind: "prefix_not_empty", verdict };

  // (1) Evidence before destruction.
  await writeAuditRow(db, {
    tenantId,
    deletingAtMs: user.deleting_at_ms,
    completedAtMs,
    residue: completion.residue !== 0,
    firstCompletedAtMs: completion.first_completed_at_ms,
    firstResidue: completion.first_residue !== 0,
    nowMs: input.nowMs,
  });

  // (2) Durable Object state, fail-closed: a throw here leaves every D1 row in
  // place for the next tick, with the audit row already committed.
  await purgeTenantUsageGuard(env, tenantId);
  await purgeGlobalUsageLeases(env, tenantId);

  // (3) The rows, in one batch.
  //
  // The addresses are collected BEFORE the batch, because the batch is what
  // deletes the rows that name them.
  const statements = teardownStatements(
    tenantId,
    await addressesEverUsed(db, tenantId, user.email_canonical),
  );
  const results = await db.batch(statements);
  // Every statement carries the same `status = 'deleting'` predicate, so if the
  // account was reactivated during the Durable Object round-trips the whole
  // batch matches nothing and the account is left whole rather than gutted.
  // The `users` delete is last, and its changing exactly one row is the only
  // proof the teardown actually happened — without this check a reactivated
  // account would still be reported, and logged, as torn down.
  const usersDeleted = results[results.length - 1]?.changes ?? 0;
  if (usersDeleted !== 1) return await lostRace(db, tenantId);
  const rowsDeleted = results.reduce((total, result) => total + result.changes, 0);
  return { kind: "torn_down", tenantId, rowsDeleted };
}

/**
 * The batch matched nothing. Say which of the two races was lost.
 *
 * Only reached on the rare path, so two extra reads cost nothing, and the
 * caller logs the reason — "teardown did nothing" repeating every fifteen
 * minutes with no cause named is the kind of thing nobody diagnoses.
 */
async function lostRace(db: ControlPlaneDb, tenantId: TenantId): Promise<AccountTeardownResult> {
  const user = await db.first<{ status: string }>(
    "SELECT status FROM users WHERE id = ?",
    tenantId,
  );
  // Another delivery got there first and finished the job. Not a race lost so
  // much as a race already won.
  if (!user) return { kind: "already_torn_down" };
  if (user.status !== "deleting") return { kind: "reactivated" };
  return { kind: "wipe_reopened" };
}

/**
 * The audit row, upserted.
 *
 * A retry after a crash refreshes what the wipe reported — a reopened and
 * re-completed wipe can land a later `completed_at_ms` and a different
 * `residue` — but never moves `torn_down_at_ms`, which records the first
 * attempt. That first stamp is the evidence; overwriting it on every retry
 * would quietly rewrite when the account's deletion actually began to happen.
 */
async function writeAuditRow(
  db: ControlPlaneDb,
  input: {
    tenantId: TenantId;
    deletingAtMs: number | null;
    completedAtMs: number;
    residue: boolean;
    firstCompletedAtMs: number | null;
    firstResidue: boolean;
    nowMs: number;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO account_deletions (
       tenant_id, deleting_at_ms, completed_at_ms, residue,
       first_completed_at_ms, first_residue, torn_down_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       deleting_at_ms = excluded.deleting_at_ms,
       completed_at_ms = excluded.completed_at_ms,
       residue = excluded.residue,
       first_completed_at_ms = excluded.first_completed_at_ms,
       first_residue = excluded.first_residue`,
    input.tenantId,
    input.deletingAtMs,
    input.completedAtMs,
    input.residue ? 1 : 0,
    input.firstCompletedAtMs,
    input.firstResidue ? 1 : 0,
    input.nowMs,
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
 * Read before the batch, because the batch deletes those very rows.
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
 * Every row keyed to this tenant, children before parents.
 *
 * Order is load-bearing even though nothing enforces it at runtime today:
 * `api_token_scopes` is reachable only through `api_tokens`, so it goes first
 * or its rows become unreachable orphans; `wipe_progress` goes before `users`
 * for the same reason; and `users` goes last because everything above names it.
 * The node-pool test helper runs with `PRAGMA foreign_keys = ON`, so a wrong
 * order fails a test rather than silently leaving debris in production.
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
 * by address rather than by id — and by *every* address this account ever used,
 * not only its current one. See `addressesEverUsed`.
 *
 * Two tables are named here only to say they are NOT touched, because "we
 * deleted everything" is a claim that has to be exact:
 *
 * - `AuthRateGuard` (a Durable Object, not a table) is a singleton of hashed,
 *   TTL-windowed email/IP counters with no tenant key to purge by.
 * - `dev_mail_outbox` holds `to_email` and magic-link URLs, but it is the
 *   local-only sink: `LOCAL_MAIL_SINK` is never enabled on staging or
 *   production, so the table is empty in every environment an account can
 *   actually be deleted in.
 *
 * S5's residue scan states both out loud rather than implying they were
 * covered.
 *
 * Every statement carries the same `status = 'deleting'` predicate, not just
 * the last one. The status was read before two Durable Object round-trips, and
 * an account that leaves `deleting` in that window (an operator reactivation,
 * some future undelete) must keep its D1 rows rather than being stripped of its
 * tokens, sessions, settings and limits around a surviving `users` row.
 * All-or-nothing on one condition, which the caller then confirms by checking
 * that the final statement changed exactly one row.
 *
 * "All-or-nothing" is about D1 only, and the boundary is worth stating exactly:
 * the audit row and both Durable Object purges have already run by the time
 * this batch refuses. A reactivated account therefore comes back with its rows
 * intact but its usage guard emptied — request-rate window, hourly and monthly
 * counters, reservations, leases — and a standing `account_deletions` row. So
 * an audit row is evidence that teardown was *attempted*, never on its own that
 * an account was deleted; the absence of the `users` row is what says that. No
 * code path moves a row from `deleting` back to `active` today, so this is a
 * defensive guarantee, described here rather than overclaimed.
 */
function teardownStatements(tenantId: TenantId, addresses: string[]): SqlStatement[] {
  const stillDeleting = "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'deleting')";
  // The gate that was read before the Durable Object round-trips, re-asserted
  // in SQL. A concurrent fan-out tick can reopen a finished wipe in that window
  // (`reopenWipeProgress` clears `completed_at_ms`); without this the batch
  // would delete the reopened record and the `users` row, stranding the pass
  // and orphaning whatever it had not yet removed — with the tenant no longer
  // enumerable to find it again.
  //
  // Phrased as "no reopened record survives" rather than "a completed record
  // exists", because statements in a batch run in order and the `wipe_progress`
  // delete two lines above has already removed the completed row by the time
  // this is evaluated. A reopened row is precisely the one that delete does NOT
  // match, so its survival is the signal.
  const noReopenedWipe =
    "NOT EXISTS (SELECT 1 FROM wipe_progress WHERE tenant_id = ? AND completed_at_ms IS NULL)";
  // Both conditions on EVERY statement, not only the last. Guarding just the
  // `users` delete would leave the other race — a reopened wipe — stripping the
  // account's tokens, sessions, settings and limits around a `users` row the
  // guard then refuses to delete: a gutted account, which is worse than either
  // finishing or doing nothing. Two bound tenant ids, one per EXISTS.
  const guard = `${stillDeleting} AND ${noReopenedWipe}`;
  const guardParams = [tenantId, tenantId];
  // The account's current address is always first (see `addressesEverUsed`).
  const emailCanonical = addresses[0]!;
  return [
    {
      sql: `DELETE FROM api_token_scopes
             WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)
               AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    {
      sql: `DELETE FROM api_tokens WHERE user_id = ? AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    {
      sql: `DELETE FROM sessions WHERE user_id = ? AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    {
      // Three arms, and each one catches rows the others miss. Nothing else in
      // this codebase ever deletes from `auth_challenges` — there is no TTL
      // prune — so a row missed here is a permanent record of a deleted
      // account's address.
      //
      // One shape is knowingly missed, and it is a residue rather than a bug we
      // can close here: a login challenge that was issued and then superseded
      // (revoked) at signup, on an address the account has since changed away
      // from. It has `user_id IS NULL` (the address had no user yet) and
      // `completed_user_id IS NULL` (it was never redeemed), so no arm reaches
      // it, and the address on it is one the account no longer holds. The
      // reason it is not swept by address is the arm below: on a *released*
      // address, a NULL-owner row may equally belong to somebody signing up
      // there now, and deleting theirs is the worse error. Closing it properly
      // needs a durable owner link that the schema does not have.
      //
      // `user_id` is this account's own challenges, including an `email_change`
      // aimed at some other address. `completed_user_id` is the signup
      // challenge that created the account: it was issued with a NULL
      // `user_id`, and if the address was later changed its `email_canonical`
      // is no longer the account's, so neither other arm would reach it. The
      // NULL-owner arm frees the `auth_challenges_one_issued` slot for the
      // released address.
      //
      // Deliberately NOT "every row matching the address": that would also
      // destroy a different, live user's in-flight `email_change` challenge
      // targeting it.
      //
      // And the NULL-owner arm is deliberately bound to the CURRENT address
      // only, not to every address in `addressesEverUsed`. A NULL-owner
      // challenge on a *released* address belongs to whoever is signing up
      // there now — widening it would break a stranger's in-flight signup, the
      // same cross-account harm in a new place. On the current address no such
      // row can be anyone else's: while a live user owns an address, a login
      // challenge for it carries that user's id, never NULL.
      sql: `DELETE FROM auth_challenges
             WHERE (
                     user_id = ?
                     OR completed_user_id = ?
                     OR (email_canonical = ? AND user_id IS NULL)
                   )
               AND ${guard}`,
      params: [tenantId, tenantId, emailCanonical, ...guardParams],
    },
    {
      sql: `DELETE FROM digest_deliveries WHERE user_id = ? AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    {
      sql: `DELETE FROM user_settings WHERE user_id = ? AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    {
      sql: `DELETE FROM tenant_limits WHERE tenant_id = ? AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    // Every address the account ever used, not just its last one — an invite
    // row for a previous address would otherwise outlive the account, carrying
    // its old `email_display` and blocking re-signup there forever.
    //
    // Chunked, because this is the one statement whose parameter count grows
    // with the account's history. D1 caps bound parameters per query, and going
    // over would throw inside an all-or-nothing batch — wedging teardown on
    // every cron tick forever, with the audit row already written and nothing
    // deleted. A cap that fails safe beats a limit discovered in production.
    //
    // `consumed_at_ms IS NOT NULL` is the other half of not reaching into
    // somebody else's account, and it is what makes the address list safe even
    // though ownership is only ever proven as of the past. An address this
    // account released can legitimately have been re-invited to someone else
    // since; that invite is UNCONSUMED — a pending grant — and teardown must
    // not destroy it. This account's own invite was spent at signup, so it is
    // consumed, so it still goes. The documented "a re-signup needs a fresh
    // invite" behaviour is unchanged, and an invite an operator issues for the
    // freed address during the deleting window now survives instead of being
    // silently swept by the next tick.
    //
    // The current address is the exception to the consumed rule, because
    // "an account's own invite is always consumed" is not true for it.
    // `consumeChallenge` is the only writer of `consumed_at_ms` and it runs on
    // the login path only; `completeEmailChange` swaps `users.email_canonical`
    // without touching `signup_invites`. So an account that moved to an address
    // holding an outstanding invite owns that address with the invite still
    // unconsumed. That row is not a third party's grant — it names the address
    // this teardown is releasing, and an invite for an address that already
    // maps to a live user is inert anyway, since `resolveLoginEligibility`
    // returns the existing user and never looks at it.
    ...chunk(addresses, INVITE_DELETE_CHUNK).map((group) => ({
      sql: `DELETE FROM signup_invites
             WHERE email_canonical IN (${group.map(() => "?").join(", ")})
               AND (consumed_at_ms IS NOT NULL OR email_canonical = ?)
               AND ${guard}`,
      params: [...group, emailCanonical, ...guardParams],
    })),
    {
      sql: `DELETE FROM wipe_progress
             WHERE tenant_id = ? AND completed_at_ms IS NOT NULL AND ${guard}`,
      params: [tenantId, ...guardParams],
    },
    // Last, and the one the caller counts: exactly one row here is what makes
    // the teardown real.
    {
      sql: `DELETE FROM users
             WHERE id = ? AND status = 'deleting' AND ${noReopenedWipe}`,
      params: [tenantId, tenantId],
    },
  ];
}

/** Well under D1's per-query bound-parameter cap, with room for the guard. */
const INVITE_DELETE_CHUNK = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}
