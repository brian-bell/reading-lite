import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETE_REVOCATION_REASON,
  beginAccountDeletion,
  tenantIsActive,
} from "../../../src/control-plane/account-delete";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "../../../src/control-plane/constants";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";

async function seeded() {
  const { raw, db } = openControlPlane();
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
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
       ) VALUES (?, ?, 'hmac', 1, ?, ?, ?, ?, ?, 'clm_delete')`,
    SESSION,
      USER,
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS),
      toTimestamp(NOW_MS + SESSION_IDLE_TTL_MS),
      toTimestamp(NOW_MS + SESSION_ABSOLUTE_TTL_MS),
  );
  return { raw, db };
}

function recordingDb(inner: ControlPlaneDb): { db: ControlPlaneDb; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      first: (q, ...params) => inner.first(q, ...params),
      all: (q, ...params) => inner.all(q, ...params),
      transaction: (work) => inner.transaction(work),
      batch: (statements) => {
        for (const s of statements) sql.push(s.sql);
        return inner.batch(statements);
      },
      run: async (q, ...params) => {
        sql.push(q);
        return inner.run(q, ...params);
      },
    },
  };
}

describe("beginAccountDeletion", () => {
  it("marks deleting before revoking sessions and tokens", async () => {
    const { raw, db: inner } = await seeded();
    const { db, sql } = recordingDb(inner);

    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 5 })).resolves.toEqual({
      kind: "started",
    });

    const tables = sql.map((statement) => {
      const match = /UPDATE\s+(\w+)/i.exec(statement);
      return match?.[1];
    });
    expect(tables[0]).toBe("users");
    expect(tables.indexOf("users")).toBeLessThan(tables.indexOf("sessions"));
    expect(tables.indexOf("sessions")).toBeLessThan(tables.indexOf("api_tokens"));

    const user = withMs(await raw.first("SELECT status, deleting_at FROM users WHERE id = ?", USER)) as {
      status: string;
      deleting_at_ms: number;
    };
    expect(user).toEqual({ status: "deleting", deleting_at_ms: NOW_MS + 5 });

    const session = withMs(await raw.first(
      "SELECT revoked_at, revocation_reason FROM sessions WHERE id = ?",
      SESSION,
    )) as { revoked_at_ms: number; revocation_reason: string };
    expect(session.revoked_at_ms).toBe(NOW_MS + 5);
    expect(session.revocation_reason).toBe(ACCOUNT_DELETE_REVOCATION_REASON);

    const token = withMs(await raw.first("SELECT revoked_at FROM api_tokens WHERE id = ?", TOKEN)) as {
      revoked_at_ms: number;
    };
    expect(token.revoked_at_ms).toBe(NOW_MS + 5);
  });

  it("is idempotent once deleting and does not require a second status write", async () => {
    const { raw, db } = await seeded();
    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 1 })).resolves.toEqual({
      kind: "started",
    });
    await raw.run("UPDATE api_tokens SET revoked_at = NULL WHERE id = ?", TOKEN);

    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 9 })).resolves.toEqual({
      kind: "already_deleting",
    });
    const user = withMs(await raw.first("SELECT deleting_at FROM users WHERE id = ?", USER)) as {
      deleting_at_ms: number;
    };
    expect(user.deleting_at_ms).toBe(NOW_MS + 1);
    const token = withMs(await raw.first("SELECT revoked_at FROM api_tokens WHERE id = ?", TOKEN)) as {
      revoked_at_ms: number | null;
    };
    expect(token.revoked_at_ms).toBe(NOW_MS + 9);
  });

  // The rerun on `already_deleting` is what repairs a crash between the
  // status write and the cancel.
  it.each(["active", "deleting"] as const)(
    "cancels the active archive export of an %s account and leaves finished ones",
    async (status) => {
      const { raw, db } = await seeded();
      await raw.run("UPDATE users SET status = ? WHERE id = ?", status, USER);
      for (const [id, exportStatus, requestedAtMs] of [
        ["exp_active", "building", NOW_MS - 1],
        ["exp_ready", "ready", NOW_MS - 2],
        ["exp_failed", "failed", NOW_MS - 3],
      ] as const) {
        await raw.run(
          `INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          id,
          USER,
          exportStatus,
          toTimestamp(requestedAtMs),
          toTimestamp(requestedAtMs),
        );
      }

      await beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 7 });

      const rows = withMs(
        await raw.all(
          "SELECT id, status, completed_at, lease_seq FROM archive_exports WHERE tenant_id = ? ORDER BY id",
          USER,
        ),
      );
      expect(rows).toEqual([
        { id: "exp_active", status: "cancelled", completed_at_ms: NOW_MS + 7, lease_seq: 1 },
        { id: "exp_failed", status: "failed", completed_at_ms: null, lease_seq: 0 },
        { id: "exp_ready", status: "ready", completed_at_ms: null, lease_seq: 0 },
      ]);
    },
  );

  it("removes every provider credential on start and again when already deleting", async () => {
    const { raw, db } = await seeded();
    const insert = async () => {
      for (const provider of ["openai", "anthropic"]) {
        await raw.run(
          `INSERT INTO tenant_provider_credentials (
             tenant_id, provider, ciphertext, iv, key_version, credential_version,
             last_four, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 1, '9876', 'active', ?, ?)`,
          USER,
          provider,
          Buffer.from("sealed"),
          Buffer.from("0123456789ab"),
          toTimestamp(NOW_MS),
          toTimestamp(NOW_MS),
        );
      }
    };
    await insert();

    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 5 })).resolves.toEqual({
      kind: "started",
    });
    expect(
      await raw.first("SELECT tenant_id FROM tenant_provider_credentials WHERE tenant_id = ?", USER),
    ).toBeNull();

    await insert();
    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 9 })).resolves.toEqual({
      kind: "already_deleting",
    });
    expect(
      await raw.first("SELECT tenant_id FROM tenant_provider_credentials WHERE tenant_id = ?", USER),
    ).toBeNull();
  });

  it("refuses a suspended account without marking deleting", async () => {
    const { raw, db } = await seeded();
    await raw.run("UPDATE users SET status = 'suspended' WHERE id = ?", USER);
    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS })).resolves.toEqual({
      kind: "not_active",
    });
    expect((withMs(await raw.first("SELECT status FROM users WHERE id = ?", USER)) as { status: string }).status).toBe(
      "suspended",
    );
  });
});

describe("tenantIsActive", () => {
  it("is true only for an active row", async () => {
    const { raw, db } = await seeded();
    await expect(tenantIsActive(db, USER)).resolves.toBe(true);
    await raw.run("UPDATE users SET status = 'deleting' WHERE id = ?", USER);
    await expect(tenantIsActive(db, USER)).resolves.toBe(false);
    await expect(tenantIsActive(db, "usr_11111111-1111-4111-8111-111111111111")).resolves.toBe(false);
  });

  it("does not treat a database throw as inactive", async () => {
    const db: ControlPlaneDb = {
      first: async () => {
        throw new Error("database hiccup");
      },
      all: async () => [],
      batch: async () => [],
      run: async () => ({ changes: 0 }),
      transaction: async () => {
        throw new Error("unused");
      },
    };
    await expect(tenantIsActive(db, USER)).rejects.toThrow("database hiccup");
  });
});
