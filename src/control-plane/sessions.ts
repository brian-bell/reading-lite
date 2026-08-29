import { FOUNDER_PLACEHOLDER_LIMITS } from "./bootstrap";
import {
  MAX_ACTIVE_SESSIONS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_LAST_SEEN_COALESCE_MS,
} from "./constants";
import { formatCredential, mintSecretHex, parseCredential, type RandomBytes } from "./credential";
import { readSessionCookie } from "./cookies";
import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import { isUniqueConstraintError, type ControlPlaneDb } from "./db";
import { matchSecretHmac } from "./hmac-match";
import {
  mintSessionId,
  mintUserId,
  parseSessionId,
  parseUserId,
  type SessionId,
  type UserId,
  type UuidSource,
} from "./ids";
import { createSessionPrincipal, type AuthenticatedPrincipal } from "./principal";

interface SessionRow {
  id: string;
  user_id: string;
  secret_hmac: string;
  hash_key_version: number;
  created_at_ms: number;
  authenticated_at_ms: number;
  last_seen_at_ms: number;
  idle_expires_at_ms: number;
  absolute_expires_at_ms: number;
  revoked_at_ms: number | null;
  created_from_claim_id: string;
}

export async function ensureUserWithDefaults(
  db: ControlPlaneDb,
  input: {
    emailCanonical: string;
    emailDisplay: string;
    nowMs: number;
    newUuid?: UuidSource;
  },
): Promise<UserId> {
  const existing = await db.first<{ id: string }>(
    "SELECT id FROM users WHERE email_canonical = ?",
    input.emailCanonical,
  );
  const userId = existing ? requireUserId(existing.id) : mintUserId(input.newUuid);

  await db.batch([
    {
      sql: `INSERT INTO users (
              id, email_canonical, email_display, status,
              email_verified_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(email_canonical) DO NOTHING`,
      params: [userId, input.emailCanonical, input.emailDisplay, input.nowMs, input.nowMs, input.nowMs],
    },
    {
      sql: `INSERT INTO user_settings (
              user_id, schema_version, notify_immediate, digest_cadence,
              time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms
            ) SELECT id, 1, 1, 'off', 'UTC', 9, 1, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(user_id) DO NOTHING`,
      params: [input.nowMs, input.nowMs, input.emailCanonical],
    },
    {
      sql: `INSERT INTO tenant_limits (
              tenant_id, policy_version, submissions_per_hour, monthly_readings,
              max_concurrent_work, daily_spend_microdollars, created_at_ms, updated_at_ms
            ) SELECT id, 1, ?, ?, ?, ?, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(tenant_id) DO NOTHING`,
      params: [
        FOUNDER_PLACEHOLDER_LIMITS.submissions_per_hour,
        FOUNDER_PLACEHOLDER_LIMITS.monthly_readings,
        FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
        FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
        input.nowMs,
        input.nowMs,
        input.emailCanonical,
      ],
    },
  ]);

  const resolved = await db.first<{ id: string }>(
    "SELECT id FROM users WHERE email_canonical = ?",
    input.emailCanonical,
  );
  if (!resolved) throw new Error("failed to persist user");
  return requireUserId(resolved.id);
}

export async function issueSessionForClaim(
  db: ControlPlaneDb,
  input: {
    userId: UserId;
    claimId: string;
    nowMs: number;
    authRoot: AuthRoot;
    userAgentLabel: string | null;
    randomBytes?: RandomBytes;
    newUuid?: UuidSource;
  },
): Promise<{ sessionId: SessionId; credential: string }> {
  const existing = await lookupUsableSessionForClaim(db, input.userId, input.claimId, input.nowMs);
  if (existing) {
    return rotateOwnSessionSecret(db, existing, input.userId, input.authRoot, input.randomBytes);
  }

  await revokeLruIfAtCap(db, input.userId, input.nowMs);

  const sessionId = mintSessionId(input.newUuid);
  const secret = mintSecretHex(input.randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "session"), secret);
  try {
    await db.run(
      `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version,
         created_at_ms, authenticated_at_ms, last_seen_at_ms,
         idle_expires_at_ms, absolute_expires_at_ms, user_agent_label, created_from_claim_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      input.userId,
      secretHmac,
      input.authRoot.version,
      input.nowMs,
      input.nowMs,
      input.nowMs,
      input.nowMs + SESSION_IDLE_TTL_MS,
      input.nowMs + SESSION_ABSOLUTE_TTL_MS,
      input.userAgentLabel,
      input.claimId,
    );
  } catch (err) {
    const raced = await lookupUsableSessionForClaim(db, input.userId, input.claimId, input.nowMs);
    if (raced) {
      return rotateOwnSessionSecret(db, raced, input.userId, input.authRoot, input.randomBytes);
    }
    if (isUniqueConstraintError(err)) throw err;
    throw new Error("failed to persist session");
  }

  return { sessionId, credential: formatCredential(sessionId, secret) };
}

export async function authenticateSession(
  db: ControlPlaneDb,
  input: {
    cookieHeader: string | undefined;
    authRoot: AuthRoot;
    previousAuthRoot?: AuthRoot;
    nowMs: number;
  },
): Promise<
  | { kind: "ok"; principal: Extract<AuthenticatedPrincipal, { kind: "session" }> }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
> {
  const raw = readSessionCookie(input.cookieHeader);
  if (!raw) return { kind: "unauthenticated" };
  const presented = parseCredential(raw, parseSessionId);
  if (!presented) return { kind: "unauthenticated" };

  const row = await db.first<SessionRow>("SELECT * FROM sessions WHERE id = ?", presented.selector);
  const match = await matchSecretHmac(
    presented.secret,
    row?.secret_hmac ?? null,
    input.authRoot,
    input.previousAuthRoot,
    "session",
  );
  if (!row || !match.ok) return { kind: "unauthenticated" };
  if (!sessionUsable(row, input.nowMs)) return { kind: "unauthenticated" };

  if (match.viaPrevious) {
    try {
      const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "session"), presented.secret);
      await db.run(
        "UPDATE sessions SET secret_hmac = ?, hash_key_version = ? WHERE id = ?",
        secretHmac,
        input.authRoot.version,
        row.id,
      );
    } catch {
      // Best-effort re-HMAC during rotation.
    }
  }

  const user = await db.first<{ id: string; status: string }>(
    "SELECT id, status FROM users WHERE id = ?",
    row.user_id,
  );
  if (!user) return { kind: "unauthenticated" };
  if (user.status !== "active") return { kind: "forbidden" };

  await touchLastSeen(db, row, input.nowMs);

  try {
    return {
      kind: "ok",
      principal: createSessionPrincipal({
        tenantId: user.id,
        userId: user.id,
        sessionId: row.id,
        authenticatedAtMs: row.authenticated_at_ms,
      }),
    };
  } catch {
    return { kind: "unauthenticated" };
  }
}

export async function revokeSession(
  db: ControlPlaneDb,
  sessionId: string,
  nowMs: number,
  reason: string,
): Promise<void> {
  await db.run(
    `UPDATE sessions
     SET revoked_at_ms = ?, revocation_reason = ?
     WHERE id = ? AND revoked_at_ms IS NULL`,
    nowMs,
    reason,
    sessionId,
  );
}

function sessionUsable(row: SessionRow, nowMs: number): boolean {
  return row.revoked_at_ms == null && row.idle_expires_at_ms > nowMs && row.absolute_expires_at_ms > nowMs;
}

async function touchLastSeen(db: ControlPlaneDb, row: SessionRow, nowMs: number): Promise<void> {
  if (nowMs - row.last_seen_at_ms < SESSION_LAST_SEEN_COALESCE_MS) return;
  try {
    await db.run(
      `UPDATE sessions
       SET last_seen_at_ms = ?, idle_expires_at_ms = ?
       WHERE id = ? AND revoked_at_ms IS NULL`,
      nowMs,
      nowMs + SESSION_IDLE_TTL_MS,
      row.id,
    );
  } catch {
    // Auth still succeeds if the coalesce write fails.
  }
}

async function lookupUsableSessionForClaim(
  db: ControlPlaneDb,
  userId: UserId,
  claimId: string,
  nowMs: number,
): Promise<SessionRow | null> {
  return db.first<SessionRow>(
    `SELECT * FROM sessions
     WHERE created_from_claim_id = ?
       AND user_id = ?
       AND revoked_at_ms IS NULL
       AND idle_expires_at_ms > ?
       AND absolute_expires_at_ms > ?`,
    claimId,
    userId,
    nowMs,
    nowMs,
  );
}

async function rotateOwnSessionSecret(
  db: ControlPlaneDb,
  row: SessionRow,
  userId: UserId,
  authRoot: AuthRoot,
  randomBytes?: RandomBytes,
): Promise<{ sessionId: SessionId; credential: string }> {
  if (row.user_id !== userId) {
    throw new Error("session claim belongs to another user");
  }
  return rotateSessionSecret(db, row, authRoot, randomBytes);
}

async function rotateSessionSecret(
  db: ControlPlaneDb,
  row: SessionRow,
  authRoot: AuthRoot,
  randomBytes?: RandomBytes,
): Promise<{ sessionId: SessionId; credential: string }> {
  const sessionId = requireSessionId(row.id);
  const secret = mintSecretHex(randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(authRoot, "session"), secret);
  await db.run(
    "UPDATE sessions SET secret_hmac = ?, hash_key_version = ? WHERE id = ?",
    secretHmac,
    authRoot.version,
    sessionId,
  );
  return { sessionId, credential: formatCredential(sessionId, secret) };
}

async function revokeLruIfAtCap(db: ControlPlaneDb, userId: UserId, nowMs: number): Promise<void> {
  const active = await db.all<{ id: string }>(
    `SELECT id FROM sessions
     WHERE user_id = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND absolute_expires_at_ms > ?
     ORDER BY last_seen_at_ms ASC`,
    userId,
    nowMs,
    nowMs,
  );
  if (active.length < MAX_ACTIVE_SESSIONS) return;
  const lru = active[0];
  if (!lru) return;
  await revokeSession(db, lru.id, nowMs, "session_cap");
}

function requireUserId(raw: string): UserId {
  const parsed = parseUserId(raw);
  if (!parsed) throw new Error("malformed user id");
  return parsed;
}

function requireSessionId(raw: string): SessionId {
  const parsed = parseSessionId(raw);
  if (!parsed) throw new Error("malformed session id");
  return parsed;
}
