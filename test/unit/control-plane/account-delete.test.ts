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
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";

async function seeded() {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => TOKEN,
  });
  sqlite
    .prepare(
      `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version,
         created_at_ms, authenticated_at_ms, last_seen_at_ms,
         idle_expires_at_ms, absolute_expires_at_ms, created_from_claim_id
       ) VALUES (?, ?, 'hmac', 1, ?, ?, ?, ?, ?, 'clm_delete')`,
    )
    .run(
      SESSION,
      USER,
      NOW_MS,
      NOW_MS,
      NOW_MS,
      NOW_MS + SESSION_IDLE_TTL_MS,
      NOW_MS + SESSION_ABSOLUTE_TTL_MS,
    );
  return { sqlite, db };
}

function recordingDb(inner: ControlPlaneDb): { db: ControlPlaneDb; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      first: (q, ...params) => inner.first(q, ...params),
      all: (q, ...params) => inner.all(q, ...params),
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
    const { sqlite, db: inner } = await seeded();
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

    const user = sqlite.prepare("SELECT status, deleting_at_ms FROM users WHERE id = ?").get(USER) as {
      status: string;
      deleting_at_ms: number;
    };
    expect(user).toEqual({ status: "deleting", deleting_at_ms: NOW_MS + 5 });

    const session = sqlite
      .prepare("SELECT revoked_at_ms, revocation_reason FROM sessions WHERE id = ?")
      .get(SESSION) as { revoked_at_ms: number; revocation_reason: string };
    expect(session.revoked_at_ms).toBe(NOW_MS + 5);
    expect(session.revocation_reason).toBe(ACCOUNT_DELETE_REVOCATION_REASON);

    const token = sqlite.prepare("SELECT revoked_at_ms FROM api_tokens WHERE id = ?").get(TOKEN) as {
      revoked_at_ms: number;
    };
    expect(token.revoked_at_ms).toBe(NOW_MS + 5);
  });

  it("is idempotent once deleting and does not require a second status write", async () => {
    const { sqlite, db } = await seeded();
    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 1 })).resolves.toEqual({
      kind: "started",
    });
    sqlite
      .prepare("UPDATE api_tokens SET revoked_at_ms = NULL WHERE id = ?")
      .run(TOKEN);

    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS + 9 })).resolves.toEqual({
      kind: "already_deleting",
    });
    const user = sqlite.prepare("SELECT deleting_at_ms FROM users WHERE id = ?").get(USER) as {
      deleting_at_ms: number;
    };
    expect(user.deleting_at_ms).toBe(NOW_MS + 1);
    const token = sqlite.prepare("SELECT revoked_at_ms FROM api_tokens WHERE id = ?").get(TOKEN) as {
      revoked_at_ms: number | null;
    };
    expect(token.revoked_at_ms).toBe(NOW_MS + 9);
  });

  it("refuses a suspended account without marking deleting", async () => {
    const { sqlite, db } = await seeded();
    sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(USER);
    await expect(beginAccountDeletion(db, { userId: USER, nowMs: NOW_MS })).resolves.toEqual({
      kind: "not_active",
    });
    expect((sqlite.prepare("SELECT status FROM users WHERE id = ?").get(USER) as { status: string }).status).toBe(
      "suspended",
    );
  });
});

describe("tenantIsActive", () => {
  it("is true only for an active row", async () => {
    const { sqlite, db } = await seeded();
    await expect(tenantIsActive(db, USER)).resolves.toBe(true);
    sqlite.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").run(USER);
    await expect(tenantIsActive(db, USER)).resolves.toBe(false);
    await expect(tenantIsActive(db, "usr_11111111-1111-4111-8111-111111111111")).resolves.toBe(false);
  });
});
