// Control-plane teardown (issue 195 S4 / #263): the gate, the ordering, the
// audit row that outlives the account, and email reuse.
//
// PostgreSQL enforces the foreign keys here as in production, so a delete in
// the wrong order fails.

import { describe, expect, it } from "vitest";
import { beginAccountDeletion } from "../../../src/control-plane/account-delete";
import {
  tearDownAccount,
  type AccountTeardownEnv,
  type PrefixVerdict,
} from "../../../src/control-plane/account-teardown";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { resolveLoginEligibility } from "../../../src/control-plane/eligibility";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-04T10:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";
const CHALLENGE = "ml_550e8400-e29b-41d4-a716-446655440000";
const EMAIL = "founder@example.com";

/** Every table teardown is responsible for emptying, and how it is keyed. */
const CHILD_TABLES: ReadonlyArray<{ table: string; column: string; value: string }> = [
  { table: "user_settings", column: "user_id", value: USER },
  { table: "tenant_limits", column: "tenant_id", value: USER },
  { table: "api_tokens", column: "user_id", value: USER },
  { table: "sessions", column: "user_id", value: USER },
  { table: "auth_challenges", column: "email_canonical", value: EMAIL },
  { table: "digest_deliveries", column: "user_id", value: USER },
  { table: "relationship_refresh_jobs", column: "tenant_id", value: USER },
  { table: "tension_refresh_jobs", column: "tenant_id", value: USER },
  { table: "corpus_refresh_state", column: "tenant_id", value: USER },
  { table: "signup_invites", column: "email_canonical", value: EMAIL },
  { table: "wipe_progress", column: "tenant_id", value: USER },
  { table: "archive_exports", column: "tenant_id", value: USER },
  { table: "tenant_provider_credentials", column: "tenant_id", value: USER },
];

/**
 * The precondition teardown checks for itself: the wipe emptied the prefix.
 * Every case that is not about the prefix passes this.
 */
const emptyPrefix = async (): Promise<PrefixVerdict> => "empty";

/** A namespace that records the purge bodies it was sent. */
function fakeGuardNamespace(options: { fails?: boolean } = {}): {
  ns: DurableObjectNamespace;
  bodies: unknown[];
  names: string[];
} {
  const bodies: unknown[] = [];
  const names: string[] = [];
  const ns = {
    idFromName(name: string) {
      names.push(name);
      return name;
    },
    get() {
      return {
        async fetch(_url: string, init: { body: string }) {
          bodies.push(JSON.parse(init.body));
          if (options.fails) return new Response("nope", { status: 500 });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ns, bodies, names };
}

function guardEnv(options: { tenantFails?: boolean; globalFails?: boolean } = {}): {
  env: AccountTeardownEnv;
  tenant: ReturnType<typeof fakeGuardNamespace>;
  global: ReturnType<typeof fakeGuardNamespace>;
} {
  const tenant = fakeGuardNamespace({ fails: options.tenantFails });
  const global = fakeGuardNamespace({ fails: options.globalFails });
  return {
    env: { TENANT_USAGE_GUARD: tenant.ns, GLOBAL_USAGE_GUARD: global.ns },
    tenant,
    global,
  };
}

/** A tenant that has been fenced by `DELETE /api/account` and fully populated. */
async function seeded(options: { signupMode?: "open" | "invite_only" } = {}) {
  const { raw, db } = openControlPlane();
  await bootstrapFounder(db, {
    email: EMAIL,
    legacyToken: "test-token",
    signupMode: options.signupMode ?? "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => TOKEN,
  });
  await raw.run(
    `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version,
         created_at, authenticated_at, last_seen_at,
         idle_expires_at, absolute_expires_at, created_from_claim_id
       ) VALUES (?, ?, 'hmac', 1, ?, ?, ?, ?, ?, 'clm_teardown')`,
    SESSION,
      USER,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS + SESSION_IDLE_TTL_MS),
      toTimestamp(NOW_MS + SESSION_ABSOLUTE_TTL_MS),
  );
  await raw.run(
    `INSERT INTO auth_challenges (
         id, purpose, email_canonical, email_display, user_id, secret_hmac,
         hash_key_version, issued_at, expires_at, state
       ) VALUES (?, 'login', ?, ?, ?, 'hmac', 1, ?, ?, 'issued')`,
    CHALLENGE, EMAIL, EMAIL, USER, toTimestamp(NOW_MS), toTimestamp(NOW_MS + 900_000),
  );
  await raw.run(
    `INSERT INTO digest_deliveries (user_id, cadence, period_key, status, created_at, updated_at)
       VALUES (?, 'daily', '2026-09-03', 'sent', ?, ?)`,
    USER, toTimestamp(NOW_MS), toTimestamp(NOW_MS),
  );
  await raw.run(
    `INSERT INTO signup_invites (email_canonical, email_display, created_at, consumed_at)
       VALUES (?, ?, ?, ?)`,
    EMAIL, EMAIL, toTimestamp(NOW_MS - 1000), toTimestamp(NOW_MS - 500),
  );
  await raw.run(
    `INSERT INTO relationship_refresh_jobs (tenant_id, reading_id, run_at, owner, source_etag, result_json)
    VALUES (?, 'rd_refresh', '2026-09-03T00:00:00.000Z', 'owner', 'etag', '{}')`,
    USER,
  );
  await raw.run(
    `INSERT INTO tension_refresh_jobs (tenant_id, reading_a, reading_b, run_at, owner, a_version, b_version)
    VALUES (?, 'rd_a', 'rd_b', '2026-09-03T00:00:00.000Z', 'owner', 'va', 'vb')`,
    USER,
  );
  await raw.run(
    `INSERT INTO corpus_refresh_state (tenant_id, state, updated_at)
    VALUES (?, '{"version":3,"last_run_at":"2026-09-03T00:00:00.000Z","list_ids":["rd_a"]}'::jsonb, ?)`,
    USER,
    toTimestamp(NOW_MS),
  );
  await raw.run(
    `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
     VALUES ('exp_teardown', ?, 'failed', ?, ?)`,
    USER,
    toTimestamp(NOW_MS),
    toTimestamp(NOW_MS),
  );
  await beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS });
  await raw.run(
    `INSERT INTO tenant_provider_credentials (
       tenant_id, provider, ciphertext, iv, key_version, credential_version,
       last_four, status, created_at, updated_at
     ) VALUES (?, 'openai', ?, ?, 1, 1, '9876', 'active', ?, ?)`,
    USER,
    Buffer.from("sealed"),
    Buffer.from("0123456789ab"),
    toTimestamp(NOW_MS),
    toTimestamp(NOW_MS),
  );
  return { raw, db };
}


/** Insert a `wipe_progress` row with an explicit completion state. */
async function wipeRecord(
  raw: ControlPlaneDb,
  fields: {
    completedAtMs: number | null;
    residue?: boolean;
    firstCompletedAtMs?: number | null;
    firstResidue?: boolean;
  },
): Promise<void> {
  await raw.run(
    `INSERT INTO wipe_progress (
         tenant_id, phase, lease_seq, updated_at, force,
         completed_at, residue, first_completed_at, first_residue
       ) VALUES (?, 'done', 3, ?, false, ?, ?, ?, ?)`,
    USER,
    toTimestamp(NOW_MS),
    toTimestamp(fields.completedAtMs),
    fields.residue ?? false,
    toTimestamp(fields.firstCompletedAtMs === undefined ? fields.completedAtMs : fields.firstCompletedAtMs),
    fields.firstResidue ?? fields.residue ?? false,
  );
}

async function count(raw: ControlPlaneDb, table: string, column: string, value: string): Promise<number> {
  const row = await raw.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, value);
  return row!.n;
}

async function auditRow(raw: ControlPlaneDb): Promise<Record<string, number | string | boolean | null> | undefined> {
  const row = await raw.first<Record<string, unknown>>("SELECT * FROM account_deletions WHERE tenant_id = ?", USER);
  return (row ? withMs(row) : undefined) as Record<string, number | string | boolean | null> | undefined;
}

/** Wraps a db so its final transaction throws, standing in for a crash mid-teardown. */
function batchThrows(inner: ControlPlaneDb): ControlPlaneDb {
  return {
    first: (sql, ...params) => inner.first(sql, ...params),
    all: (sql, ...params) => inner.all(sql, ...params),
    run: (sql, ...params) => inner.run(sql, ...params),
    batch: (statements) => inner.batch(statements),
    transaction: async () => {
      throw new Error("database died mid-teardown");
    },
  };
}

describe("tearDownAccount — the completion gate", () => {
  it("refuses a tenant with no wipe record at all and deletes nothing", async () => {
    const { raw, db } = await seeded();
    const { env, tenant, global } = guardEnv();

    await expect(tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).resolves.toEqual({
      kind: "wipe_incomplete",
    });

    expect(await count(raw, "users", "id", USER)).toBe(1);
    for (const { table, column, value } of CHILD_TABLES) {
      if (table === "wipe_progress") continue;
      expect(await count(raw, table, column, value), table).toBe(1);
    }
    // Not even the audit row: teardown that refuses must leave no trace, or the
    // residue scan would report an account as deleted while it is still whole.
    expect(await auditRow(raw)).toBeUndefined();
    expect(tenant.bodies).toEqual([]);
    expect(global.bodies).toEqual([]);
  });

  it("refuses a wipe that finished once and was then reopened", async () => {
    const { raw, db } = await seeded();
    // The reopened shape: durable history says it completed, current state says
    // there is work in flight right now. Gating on `first_completed_at_ms`
    // instead would hard-delete the users row out from under a running pass.
    await wipeRecord(raw, { completedAtMs: null, firstCompletedAtMs: NOW_MS - 60_000 });
    const { env } = guardEnv();

    await expect(tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).resolves.toEqual({
      kind: "wipe_incomplete",
    });
    expect(await count(raw, "users", "id", USER)).toBe(1);
    expect(await count(raw, "wipe_progress", "tenant_id", USER)).toBe(1);
    expect(await auditRow(raw)).toBeUndefined();
  });

  it("refuses an account that is not in the deletion pipeline", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    await raw.run("UPDATE users SET status = 'active' WHERE id = ?", USER);
    const { env } = guardEnv();

    await expect(tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).resolves.toEqual({
      kind: "not_deleting",
      status: "active",
    });
    expect(await count(raw, "users", "id", USER)).toBe(1);
    expect(await auditRow(raw)).toBeUndefined();
  });

  it.each(["not_empty", "unknown"] as const)("refuses a %s prefix verdict and deletes nothing", async (verdict) => {
    {
      const { raw, db } = await seeded();
      await wipeRecord(raw, { completedAtMs: NOW_MS });
      const { env, tenant, global } = guardEnv();

      await expect(
        tearDownAccount(db, env, {
          tenantId: USER,
          nowMs: NOW_MS,
          prefixVerdict: async () => verdict,
        }),
      ).resolves.toEqual({ kind: "prefix_not_empty", verdict });

      expect(await count(raw, "users", "id", USER), verdict).toBe(1);
      for (const { table, column, value } of CHILD_TABLES) {
        expect(await count(raw, table, column, value), `${verdict}:${table}`).toBe(1);
      }
      // Same boundary as a lost race: the prefix check is after the audit row
      // and the guard purges, so those have already run. The rows stay.
      expect(await auditRow(raw), verdict).toBeDefined();
      expect(tenant.bodies, verdict).toEqual([{ kind: "purge_tenant", tenantId: USER }]);
      expect(global.bodies, verdict).toEqual([{ kind: "purge_tenant", tenantId: USER }]);
    }
  });

  // A late publisher during either Durable Object purge or the address-history
  // lookup must not see an earlier `empty` verdict used for the hard delete:
  // cron then stops enumerating the tenant and the new object is orphaned.
  it("rechecks the prefix after the guard purges and address lookup, immediately before the final transaction", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    const order: string[] = [];
    let verdict: PrefixVerdict = "empty";
    const recording = (label: string) =>
      ({
        idFromName: (name: string) => name,
        get: () => ({
          async fetch() {
            order.push(label);
            verdict = "not_empty";
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      }) as unknown as DurableObjectNamespace;
    const wrapped: ControlPlaneDb = {
      first: (sql, ...params) => db.first(sql, ...params),
      all: (sql, ...params) => {
        order.push("addresses");
        verdict = "not_empty";
        return db.all(sql, ...params);
      },
      run: (sql, ...params) => db.run(sql, ...params),
      batch: (statements) => db.batch(statements),
      transaction: (work) => {
        order.push("rows");
        return db.transaction(work);
      },
    };

    await expect(
      tearDownAccount(
        wrapped,
        { TENANT_USAGE_GUARD: recording("purge_tenant"), GLOBAL_USAGE_GUARD: recording("purge_global") },
        {
          tenantId: USER,
          nowMs: NOW_MS,
          prefixVerdict: async () => {
            order.push("prefix");
            return verdict;
          },
        },
      ),
    ).resolves.toEqual({ kind: "prefix_not_empty", verdict: "not_empty" });

    expect(order).toEqual(["purge_tenant", "purge_global", "addresses", "prefix"]);
    expect(await count(raw, "users", "id", USER)).toBe(1);
    expect(await count(raw, "sessions", "user_id", USER)).toBe(1);
  });
  // Known residual, not asserted: a data-plane write that lands after this
  // final "empty" verdict and before the final database transaction is still
  // torn down. Teardown cannot fence R2 and PostgreSQL atomically, so the
  // recheck narrows that window rather than closing it.

  it("reports not_found for an unknown or malformed tenant", async () => {
    const { db } = await seeded();
    const { env } = guardEnv();
    await expect(
      tearDownAccount(db, env, { tenantId: "usr_11111111-1111-4111-8111-111111111111", nowMs: NOW_MS, prefixVerdict: emptyPrefix }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(tearDownAccount(db, env, { tenantId: "not-an-id", nowMs: NOW_MS, prefixVerdict: emptyPrefix })).resolves.toEqual({
      kind: "not_found",
    });
  });
});

/**
 * A reading row for the tenant, the way a wipe that missed one would leave it.
 *
 * Only the NOT NULL columns; nothing here reads the rest. `readings` names no
 * `users` row, so PostgreSQL will not refuse the teardown over it — the guard
 * under the lock is the only thing that will.
 */
async function seedReadingRow(raw: ControlPlaneDb, id: string): Promise<void> {
  await raw.run(
    `INSERT INTO readings (
         tenant_id, id, key_prefix, url, url_hash, status, created_at, updated_at,
         content_type, content_status, content_bytes, content_sha256
       ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, 'text/html', 'captured', 1, ?)`,
    USER,
    id,
    `readings/2026/09/04T100000Z-${id}`,
    `https://example.com/${id}`,
    "a".repeat(64),
    toTimestamp(NOW_MS),
    toTimestamp(NOW_MS),
    "b".repeat(64),
  );
}

async function seedInboxItem(raw: ControlPlaneDb, id: string): Promise<void> {
  await raw.run(
    `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
     VALUES (?, ?, ?, ?, '# staged', ?, ?)`,
    USER,
    `in_${id}`,
    `https://example.com/${id}`,
    // Callers' ids end in distinct digits, so each item gets its own URL slot.
    id.slice(-1).repeat(64),
    toTimestamp(NOW_MS),
    toTimestamp(NOW_MS),
  );
}

describe("tearDownAccount — reading rows outlive no account", () => {
  // `readings` has no foreign key to `users` (ADR 0005): the data plane is
  // keyed by tenant id, not joined to the control plane. So a completion
  // record is not on its own proof the rows are gone, and dropping the users
  // row while they stand orphans them past any tenant-keyed recovery — cron
  // stops enumerating the tenant the moment it leaves `listDeletingUsers`.
  // inbox_items has no foreign key to `users` either (db/migrations/0008).
  it.each([
    ["reading rows", seedReadingRow],
    ["inbox items", seedInboxItem],
  ] as const)("refuses, and deletes nothing, while the tenant still owns %s", async (_label, seed) => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    await seed(raw, "rd_0123456780");
    await seed(raw, "rd_0123456781");
    const { env } = guardEnv();

    await expect(
      tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix }),
    ).resolves.toEqual({ kind: "rows_remain", remaining: 2 });

    expect(await count(raw, "users", "id", USER)).toBe(1);
    for (const child of CHILD_TABLES) {
      expect(await count(raw, child.table, child.column, child.value)).toBeGreaterThan(0);
    }
    // The audit row still went in first: teardown was attempted, and that is
    // what the audit row records.
    expect(await auditRow(raw)).toBeDefined();
  });

  it("tears down once the rows are gone", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    await seedReadingRow(raw, "rd_0123456780");
    const { env } = guardEnv();

    expect(
      (await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).kind,
    ).toBe("rows_remain");
    await raw.run("DELETE FROM readings WHERE tenant_id = ?", USER);

    expect(
      (await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).kind,
    ).toBe("torn_down");
    expect(await count(raw, "users", "id", USER)).toBe(0);
  });
});

describe("tearDownAccount — the deletes", () => {
  it("removes every tenant-keyed row, the wipe record, and the users row", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS - 5_000 });
    const { env } = guardEnv();
    // Save child selectors before their parent rows disappear. A join through
    // api_tokens after teardown can make an orphaned scope look absent, so the
    // acceptance fixture asks scopes directly by the captured token id.
    const savedScopes = withMs(await raw.all(
      "SELECT token_id, scope FROM api_token_scopes WHERE token_id = ? ORDER BY scope",
      TOKEN,
    )) as Array<{ token_id: string; scope: string }>;
    const savedSession = withMs(await raw.first("SELECT id, user_id FROM sessions WHERE id = ?", SESSION));
    const savedChallenge = withMs(await raw.first(
      "SELECT id, user_id, completed_user_id FROM auth_challenges WHERE id = ?",
      CHALLENGE,
    ));
    expect(savedScopes.length).toBeGreaterThan(0);
    expect(savedSession).toEqual({ id: SESSION, user_id: USER });
    expect(savedChallenge).toEqual({ id: CHALLENGE, user_id: USER, completed_user_id: null });

    const result = await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });
    expect(result.kind).toBe("torn_down");

    expect(await count(raw, "users", "id", USER)).toBe(0);
    for (const { table, column, value } of CHILD_TABLES) {
      expect(await count(raw, table, column, value), table).toBe(0);
    }
    // Reachable only through api_tokens, so it has to go first or be orphaned.
    // Ask by the saved token selector rather than joining through its deleted
    // parent, which could otherwise hide an orphan.
    expect(
      withMs(await raw.all(
        "SELECT token_id, scope FROM api_token_scopes WHERE token_id = ? ORDER BY scope",
        TOKEN,
      )),
    ).toEqual([]);
    expect(withMs(await raw.first("SELECT id FROM sessions WHERE id = ?", SESSION))).toBeNull();
    expect(withMs(await raw.first("SELECT id FROM auth_challenges WHERE id = ?", CHALLENGE))).toBeNull();
  });

  it("purges the tenant guard and the tenant's global leases", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    const { env, tenant, global } = guardEnv();

    await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    // The tenant guard is addressed by tenant id; the global guard is the
    // singleton, so its purge has to name the tenant in the body instead.
    expect(tenant.names).toEqual([USER]);
    expect(tenant.bodies).toEqual([{ kind: "purge_tenant", tenantId: USER }]);
    expect(global.bodies).toEqual([{ kind: "purge_tenant", tenantId: USER }]);
    expect(global.names).not.toContain(USER);
  });

  // The status is read before two Durable Object round-trips. If the account
  // leaves `deleting` in that window it must come out whole, not gutted: every
  // statement in the batch carries the same predicate, so all of them match
  // nothing together.
  it("leaves a reactivated account entirely intact", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    // Someone flips the account back *during* the guard purge — after the
    // status read, before the batch. Reproduced by reactivating from inside the
    // stubbed Durable Object call, which is exactly that window.
    const reactivating = {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch() {
          await raw.run("UPDATE users SET status = 'active' WHERE id = ?", USER);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const env: AccountTeardownEnv = {
      TENANT_USAGE_GUARD: reactivating,
      GLOBAL_USAGE_GUARD: fakeGuardNamespace().ns,
    };

    await expect(
      tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix }),
    ).resolves.toEqual({ kind: "reactivated" });

    expect(await count(raw, "users", "id", USER)).toBe(1);
    for (const { table, column, value } of CHILD_TABLES) {
      expect(await count(raw, table, column, value), table).toBe(1);
    }
    expect(await count(raw, "api_token_scopes", "token_id", TOKEN)).toBeGreaterThan(0);
    // The audit row still stands, and should: it records that teardown was
    // attempted at this moment, which is true. A later successful run upserts
    // it. Evidence-before-destruction means evidence survives a run that then
    // destroyed nothing.
    expect(await auditRow(raw)).toBeDefined();
  });

  // The other race the batch has to survive: a concurrent fan-out tick sees
  // leftover objects and reopens the finished wipe (clearing `completed_at_ms`)
  // while the guards are being purged. Deleting the users row then would strand
  // that pass and orphan whatever it had not yet removed, with the tenant no
  // longer enumerable to find it again.
  it("leaves the account alone when a concurrent tick reopens the wipe", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS, firstCompletedAtMs: NOW_MS });
    const reopening = {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch() {
          await raw.run(
            "UPDATE wipe_progress SET completed_at = NULL, phase = 'rows' WHERE tenant_id = ?",
            USER,
          );
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    } as unknown as DurableObjectNamespace;

    await expect(
      tearDownAccount(
        db,
        { TENANT_USAGE_GUARD: reopening, GLOBAL_USAGE_GUARD: fakeGuardNamespace().ns },
        { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix },
      ),
    ).resolves.toEqual({ kind: "wipe_reopened" });

    expect(await count(raw, "users", "id", USER)).toBe(1);
    // The reopened record survives to be worked, and so does everything else.
    expect(await count(raw, "wipe_progress", "tenant_id", USER)).toBe(1);
    for (const { table, column, value } of CHILD_TABLES) {
      expect(await count(raw, table, column, value), table).toBe(1);
    }
  });

  it("is idempotent: a second run finds the account already torn down", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    const { env } = guardEnv();

    await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });
    await expect(tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS + 1000, prefixVerdict: emptyPrefix })).resolves.toEqual({
      kind: "already_torn_down",
    });
    expect((await auditRow(raw))?.torn_down_at_ms).toBe(NOW_MS);
  });
});

describe("tearDownAccount — the audit row", () => {
  it("survives the rest of teardown and carries no email or reading id", async () => {
    const { raw, db } = await seeded();
    // A wipe that finished once cleanly, was reopened, and finished again with
    // residue: the two pairs disagree, which is the whole reason both exist.
    await wipeRecord(raw, {
      completedAtMs: NOW_MS - 5_000,
      residue: true,
      firstCompletedAtMs: NOW_MS - 90_000,
      firstResidue: false,
    });
    const { env } = guardEnv();

    await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await auditRow(raw)).toEqual({
      tenant_id: USER,
      deleting_at_ms: NOW_MS,
      completed_at_ms: NOW_MS - 5_000,
      residue: true,
      // Carried across before `wipe_progress` was deleted: this is the durable
      // history S5's residue scan reads, and teardown is what destroys the only
      // other copy of it.
      first_completed_at_ms: NOW_MS - 90_000,
      first_residue: false,
      torn_down_at_ms: NOW_MS,
    });
    // The point of decision E: the record outlives the users row it names, so
    // it must not be a foreign key into it.
    expect(await count(raw, "users", "id", USER)).toBe(0);
    const columns = Object.keys(await auditRow(raw) ?? {});
    expect(columns).not.toContain("email_canonical");
    expect(columns).not.toContain("email_display");
    expect(columns).not.toContain("reading_ids");
  });

  it("is written before the destructive deletes, so a crash still leaves evidence", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS - 1 });
    const { env } = guardEnv();

    await expect(
      tearDownAccount(batchThrows(db), env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix }),
    ).rejects.toThrow("database died mid-teardown");

    expect((await auditRow(raw))?.completed_at_ms).toBe(NOW_MS - 1);
    // Nothing destructive ran, so the account is exactly as it was and the next
    // cron tick can retry it.
    expect(await count(raw, "users", "id", USER)).toBe(1);
    expect(await count(raw, "sessions", "user_id", USER)).toBe(1);
  });

  it("records a NULL deleting_at_ms rather than inventing one", async () => {
    // The F6 shape S2 added a warning for: `deleting` with no timestamp.
    const { raw, db } = await seeded();
    await raw.run("UPDATE users SET deleting_at = NULL WHERE id = ?", USER);
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    const { env } = guardEnv();

    await tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });
    expect((await auditRow(raw))?.deleting_at_ms).toBeNull();
  });
});

describe("tearDownAccount — Durable Object failure is fail-closed", () => {
  it("throws before deleting anything when a bound guard errors", async () => {
    const { raw, db } = await seeded();
    await wipeRecord(raw, { completedAtMs: NOW_MS });
    const { env } = guardEnv({ globalFails: true });

    await expect(tearDownAccount(db, env, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).rejects.toThrow(
      /purge_tenant failed/,
    );

    // The users row must not go while state keyed to that tenant may survive.
    expect(await count(raw, "users", "id", USER)).toBe(1);
    expect(await count(raw, "sessions", "user_id", USER)).toBe(1);
    // The audit row is already committed, so the retry is clean.
    expect(await auditRow(raw)).toBeDefined();
  });

});

describe("tearDownAccount — email reuse", () => {
  async function eligibility(db: ControlPlaneDb): Promise<string> {
    return (await resolveLoginEligibility(db, EMAIL, NOW_MS)).kind;
  }

  it("frees the address only once teardown has run", async () => {
    const { raw, db } = await seeded({ signupMode: "open" });
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    // Fenced but not yet torn down: the users row is still there and not
    // active, so the address is claimed and unusable by anyone.
    await expect(eligibility(db)).resolves.toBe("ineligible");

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    await expect(eligibility(db)).resolves.toBe("provisionable");
  });

  it("under invite_only the freed address needs a FRESH invite", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    // The old invite was deleted with everything else keyed to the address, so
    // the address is free but not invited — documented in docs/operations.md
    // rather than left to surprise an operator.
    expect(await count(raw, "signup_invites", "email_canonical", EMAIL)).toBe(0);
    await expect(eligibility(db)).resolves.toBe("ineligible");

    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES (?, ?, ?)`,
      EMAIL, EMAIL, toTimestamp(NOW_MS),
    );
    await expect(eligibility(db)).resolves.toBe("provisionable");
  });

  // The signup challenge that created the account: issued with a NULL user_id,
  // stamped with completed_user_id on redeem. If the account later changed
  // address, its email_canonical is no longer the account's, so neither the
  // user_id arm nor the NULL-owner-by-address arm reaches it — and nothing
  // else in this codebase ever deletes from auth_challenges, so it would be a
  // permanent record of a deleted account's old address.
  // `signup_invites` is keyed by address and `users` remembers only the current
  // one, so an account that changed address would otherwise leave the invite
  // row for its old address behind — keeping that address's `email_display`
  // and, being consumed, blocking re-signup there forever for an account that
  // no longer exists.
  it("frees every address the account ever used, not just its last one", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const oldAddress = "before-the-change@example.com";
    // The account signed up at the old address and later moved to EMAIL. Both
    // addresses were invited; both invites are consumed.
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at, consumed_at)
         VALUES (?, ?, ?, ?)`,
      oldAddress, oldAddress, toTimestamp(NOW_MS - 2000), toTimestamp(NOW_MS - 1500),
    );
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state, completed_user_id
         ) VALUES (?, 'login', ?, ?, NULL, 'hmac', 1, ?, ?, 'consumed', ?)`,
      "ml_44444444-4444-4444-8444-444444444444",
        oldAddress,
        oldAddress,
        toTimestamp(NOW_MS - 2000),
        toTimestamp(NOW_MS - 1000),
        USER,
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", oldAddress)).toBe(0);
    expect(await count(raw, "signup_invites", "email_canonical", EMAIL)).toBe(0);
    // Neither address retains anything belonging to the deleted account. Under
    // invite_only both are now "free to be invited": no user row, no consumed
    // invite standing in the way of a fresh one.
    expect((await resolveLoginEligibility(db, oldAddress, NOW_MS)).kind).toBe("ineligible");
    expect((await resolveLoginEligibility(db, EMAIL, NOW_MS)).kind).toBe("ineligible");
  });

  // The cross-account hole the address widening could have opened. An
  // `email_change` challenge stores the requester's user_id against the address
  // they *asked* for, with no proof they own it — so collecting addresses by
  // user_id alone would let anyone name a stranger's address, delete their own
  // account, and have teardown destroy that stranger's outstanding invite,
  // silently blocking their signup under invite_only. Only redemption
  // (completed_user_id) or a login challenge proves ownership.
  it("does not free an address this account merely requested via email_change", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const victim = "victim@example.com";
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES (?, ?, ?)`,
      victim, victim, toTimestamp(NOW_MS),
    );
    // Unredeemed: state 'issued', completed_user_id NULL. Nothing here proves
    // the deleted account has any claim on the address.
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'email_change', ?, ?, ?, 'hmac', 1, ?, ?, 'issued')`,
      "ml_55555555-5555-4555-8555-555555555555",
        victim,
        victim,
        USER,
        toTimestamp(NOW_MS),
        toTimestamp(NOW_MS + 900_000),
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", victim)).toBe(1);
    expect((await resolveLoginEligibility(db, victim, NOW_MS)).kind).toBe("provisionable");
    // The challenge row itself is still this tenant's and does go.
    expect(await count(raw, "auth_challenges", "user_id", USER)).toBe(0);
  });

  // The same address, once the change was actually redeemed, IS the account's.
  it("frees an address whose email_change was redeemed", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const moved = "moved-to@example.com";
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at, consumed_at)
         VALUES (?, ?, ?, ?)`,
      moved, moved, toTimestamp(NOW_MS - 2000), toTimestamp(NOW_MS - 1000),
    );
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state, completed_user_id
         ) VALUES (?, 'email_change', ?, ?, ?, 'hmac', 1, ?, ?, 'consumed', ?)`,
      "ml_66666666-6666-4666-8666-666666666666",
        moved,
        moved,
        USER,
        toTimestamp(NOW_MS - 2000),
        toTimestamp(NOW_MS - 1000),
        USER,
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", moved)).toBe(0);
  });

  // Ownership is only ever proven as of the past: an address this account
  // released can legitimately have been re-invited to somebody else since.
  // That invite is UNCONSUMED — a pending grant — and destroying it would
  // silently block a third party's signup under invite_only, which is the same
  // harm as the email_change case reached a different way.
  it("leaves an unconsumed invite for a released address alone", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const released = "released@example.com";
    // The account used to be at this address (a login challenge proves it) and
    // has since moved to EMAIL. Somebody else has now been invited there.
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'login', ?, ?, ?, 'hmac', 1, ?, ?, 'consumed')`,
      "ml_77777777-7777-4777-8777-777777777777",
        released,
        released,
        USER,
        toTimestamp(NOW_MS - 5000),
        toTimestamp(NOW_MS - 4000),
    );
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES (?, ?, ?)`,
      released, released, toTimestamp(NOW_MS - 100),
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", released)).toBe(1);
    expect((await resolveLoginEligibility(db, released, NOW_MS)).kind).toBe("provisionable");
    // The account's own consumed invite still goes.
    expect(await count(raw, "signup_invites", "email_canonical", EMAIL)).toBe(0);
  });

  it("records the known NULL-owner challenge residue while preserving a stranger's current signup", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const released = "released-with-history@example.com";
    const historicalProof = "ml_88888888-8888-4888-8888-888888888888";
    const superseded = "ml_99999999-9999-4999-8999-999999999999";
    const strangerCurrent = "ml_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // This consumed login is the recorded proof that the deleted account once
    // held the address. The two NULL-owner rows below are intentionally not
    // attributable from their stored shape: one is the account's superseded
    // pre-signup challenge and one is a stranger signing up there now.
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'login', ?, ?, NULL, 'hmac', 1, ?, ?, 'revoked')`,
      superseded, released, released, toTimestamp(NOW_MS - 6000), toTimestamp(NOW_MS - 5500),
    );
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'login', ?, ?, ?, 'hmac', 1, ?, ?, 'consumed')`,
      historicalProof, released, released, USER, toTimestamp(NOW_MS - 5000), toTimestamp(NOW_MS - 4000),
    );
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'login', ?, ?, NULL, 'hmac', 1, ?, ?, 'issued')`,
      strangerCurrent, released, released, toTimestamp(NOW_MS - 100), toTimestamp(NOW_MS + 900_000),
    );
    const retainedBefore = withMs(await raw.all(
      "SELECT * FROM auth_challenges WHERE id IN (?, ?) ORDER BY id",
      superseded, strangerCurrent,
    ));
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await expect(tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix })).resolves.toMatchObject({
      kind: "torn_down",
      tenantId: USER,
    });

    expect(await count(raw, "users", "id", USER)).toBe(0);
    expect(withMs(await raw.first("SELECT id FROM auth_challenges WHERE id = ?", historicalProof))).toBeNull();
    // The retained row is the documented permanent/unknown-attribution
    // residual. It must not be made green by pretending historical provenance
    // is reconstructible from the row itself.
    expect(
      withMs(await raw.all(
        "SELECT * FROM auth_challenges WHERE id IN (?, ?) ORDER BY id",
        superseded, strangerCurrent,
      )),
    ).toEqual(retainedBefore);
    // The same selector shape can be a live stranger's current signup, which
    // is why teardown cannot sweep all NULL-owner rows at released addresses.
  });

  // The exception to the consumed rule. "An account's own invite is always
  // consumed" is false for its CURRENT address: `consumeChallenge` only writes
  // `consumed_at_ms` on the login path, and `completeEmailChange` swaps
  // `users.email_canonical` without touching `signup_invites` at all — so an
  // account that moved to an address holding an outstanding invite owns it with
  // the invite unconsumed. Leaving that row would keep the deleted account's
  // own address and leave a standing grant on the address just freed.
  it("clears an unconsumed invite on the account's current address", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    // The seeded account's invite for EMAIL is consumed; replace it with the
    // unconsumed shape an email change into an invited address leaves behind.
    await raw.run("DELETE FROM signup_invites WHERE email_canonical = ?", EMAIL);
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES (?, ?, ?)`,
      EMAIL, EMAIL, toTimestamp(NOW_MS - 100),
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", EMAIL)).toBe(0);
  });

  // An address belonging to somebody else must not be swept up. Only addresses
  // proven to be this tenant's — via its own challenges — are collected.
  it("leaves an unrelated address's invite alone", async () => {
    const { raw, db } = await seeded({ signupMode: "invite_only" });
    const stranger = "stranger@example.com";
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES (?, ?, ?)`,
      stranger, stranger, toTimestamp(NOW_MS),
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "signup_invites", "email_canonical", stranger)).toBe(1);
    expect((await resolveLoginEligibility(db, stranger, NOW_MS)).kind).toBe("provisionable");
  });

  it("clears the signup challenge that created the account, after an address change", async () => {
    const { raw, db } = await seeded();
    const oldAddress = "before-the-change@example.com";
    const signupChallenge = "ml_33333333-3333-4333-8333-333333333333";
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state, completed_user_id
         ) VALUES (?, 'login', ?, ?, NULL, 'hmac', 1, ?, ?, 'consumed', ?)`,
      signupChallenge, oldAddress, oldAddress, toTimestamp(NOW_MS - 900_000), toTimestamp(NOW_MS), USER,
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "auth_challenges", "id", signupChallenge)).toBe(0);
    expect(await count(raw, "auth_challenges", "email_canonical", oldAddress)).toBe(0);
  });

  // Freeing the address must not reach into a live account. A different user
  // moving their own address to this one has a challenge that names the freed
  // address but belongs to them.
  it("leaves another live user's email_change challenge to that address alone", async () => {
    const { raw, db } = await seeded();
    const other = "usr_22222222-2222-4222-8222-222222222222";
    const otherChallenge = "ml_22222222-2222-4222-8222-222222222222";
    await raw.run(
      `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
         VALUES (?, 'live@example.com', 'live@example.com', 'active', ?, ?)`,
      other, toTimestamp(NOW_MS), toTimestamp(NOW_MS),
    );
    await raw.run(
      `INSERT INTO auth_challenges (
           id, purpose, email_canonical, email_display, user_id, secret_hmac,
           hash_key_version, issued_at, expires_at, state
         ) VALUES (?, 'email_change', ?, ?, ?, 'hmac', 1, ?, ?, 'claimed')`,
      otherChallenge, EMAIL, EMAIL, other, toTimestamp(NOW_MS), toTimestamp(NOW_MS + 900_000),
    );
    await wipeRecord(raw, { completedAtMs: NOW_MS });

    await tearDownAccount(db, {}, { tenantId: USER, nowMs: NOW_MS, prefixVerdict: emptyPrefix });

    expect(await count(raw, "auth_challenges", "id", otherChallenge)).toBe(1);
    expect(await count(raw, "auth_challenges", "user_id", USER)).toBe(0);
  });
});
