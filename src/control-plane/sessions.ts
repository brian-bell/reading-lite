import { FOUNDER_PLACEHOLDER_LIMITS } from "./bootstrap";
import {
  MAX_ACTIVE_SESSIONS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_CAP_WARNING,
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
import { fromTimestamp, toTimestamp } from "./pg-time";
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
  revocation_reason: string | null;
  user_agent_label: string | null;
  created_from_claim_id: string;
}

// The row as PostgreSQL returns it; SessionRow is the same in epoch ms.
interface SessionDbRow {
  id: string;
  user_id: string;
  secret_hmac: string;
  hash_key_version: number;
  created_at: string;
  authenticated_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  user_agent_label: string | null;
  created_from_claim_id: string;
}

const SESSION_COLUMNS = `id, user_id, secret_hmac, hash_key_version, created_at, authenticated_at,
       last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revocation_reason,
       user_agent_label, created_from_claim_id`;

function toSessionRow(row: SessionDbRow): SessionRow {
  return {
    id: row.id,
    user_id: row.user_id,
    secret_hmac: row.secret_hmac,
    hash_key_version: row.hash_key_version,
    created_at_ms: fromTimestamp(row.created_at),
    authenticated_at_ms: fromTimestamp(row.authenticated_at),
    last_seen_at_ms: fromTimestamp(row.last_seen_at),
    idle_expires_at_ms: fromTimestamp(row.idle_expires_at),
    absolute_expires_at_ms: fromTimestamp(row.absolute_expires_at),
    revoked_at_ms: fromTimestamp(row.revoked_at),
    revocation_reason: row.revocation_reason,
    user_agent_label: row.user_agent_label,
    created_from_claim_id: row.created_from_claim_id,
  };
}

async function selectSession(db: ControlPlaneDb, where: string, ...params: unknown[]): Promise<SessionRow | null> {
  const row = await db.first<SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${where}`, ...params);
  return row ? toSessionRow(row) : null;
}

export interface SessionListItem {
  id: string;
  current: boolean;
  created_at_ms: number;
  authenticated_at_ms: number;
  last_seen_at_ms: number;
  idle_expires_at_ms: number;
  absolute_expires_at_ms: number;
  revoked_at_ms: number | null;
  revocation_reason: string | null;
  user_agent_label: string | null;
  usable: boolean;
}

export interface SessionListResult {
  sessions: SessionListItem[];
  session_cap_warning: string | null;
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
  const now = toTimestamp(input.nowMs);

  await db.batch([
    {
      sql: `INSERT INTO users (
              id, email_canonical, email_display, status,
              email_verified_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(email_canonical) DO NOTHING`,
      params: [userId, input.emailCanonical, input.emailDisplay, now, now, now],
    },
    {
      sql: `INSERT INTO user_settings (
              user_id, schema_version, notify_immediate, digest_cadence,
              time_zone, digest_hour_local, digest_weekday, created_at, updated_at
            ) SELECT id, 1, true, 'off', 'UTC', 9, 1, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(user_id) DO NOTHING`,
      params: [now, now, input.emailCanonical],
    },
    {
      sql: `INSERT INTO tenant_limits (
              tenant_id, policy_version, submissions_per_hour, monthly_readings,
              max_concurrent_work, daily_spend_microdollars, created_at, updated_at
            ) SELECT id, 1, ?, ?, ?, ?, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(tenant_id) DO NOTHING`,
      params: [
        FOUNDER_PLACEHOLDER_LIMITS.submissions_per_hour,
        FOUNDER_PLACEHOLDER_LIMITS.monthly_readings,
        FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
        FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
        now,
        now,
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

export interface IssueSessionInput {
  userId: UserId;
  claimId: string;
  nowMs: number;
  authRoot: AuthRoot;
  userAgentLabel: string | null;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
}

export type IssueSessionResult =
  | { kind: "ok"; sessionId: SessionId; credential: string }
  | { kind: "invalid" };

export async function issueSessionForClaim(
  db: ControlPlaneDb,
  input: IssueSessionInput,
): Promise<IssueSessionResult> {
  // D1's single writer kept the cap check and the insert together. Here the
  // user row lock does, so parallel sign-ins cannot both slip under the cap.
  return db.transaction(async (tx) => {
    await tx.first("SELECT id FROM users WHERE id = ? FOR UPDATE", input.userId);
    return issueSessionLocked(tx, input);
  });
}

async function issueSessionLocked(db: ControlPlaneDb, input: IssueSessionInput): Promise<IssueSessionResult> {
  const existing = await lookupSessionForClaim(db, input.userId, input.claimId);
  if (existing) {
    if (!sessionUsable(existing, input.nowMs)) return { kind: "invalid" };
    const rotated = await rotateOwnSessionSecret(
      db,
      existing,
      input.userId,
      input.authRoot,
      input.randomBytes,
    );
    return { kind: "ok", ...rotated };
  }

  await revokeLruIfAtCap(db, input.userId, input.nowMs);

  const sessionId = mintSessionId(input.newUuid);
  const secret = mintSecretHex(input.randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "session"), secret);
  try {
    await db.run(
      `INSERT INTO sessions (
         id, user_id, secret_hmac, hash_key_version,
         created_at, authenticated_at, last_seen_at,
         idle_expires_at, absolute_expires_at, user_agent_label, created_from_claim_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      input.userId,
      secretHmac,
      input.authRoot.version,
      toTimestamp(input.nowMs),
      toTimestamp(input.nowMs),
      toTimestamp(input.nowMs),
      toTimestamp(input.nowMs + SESSION_IDLE_TTL_MS),
      toTimestamp(input.nowMs + SESSION_ABSOLUTE_TTL_MS),
      input.userAgentLabel,
      input.claimId,
    );
  } catch (err) {
    const raced = await lookupSessionForClaim(db, input.userId, input.claimId);
    if (raced && sessionUsable(raced, input.nowMs)) {
      const rotated = await rotateOwnSessionSecret(
        db,
        raced,
        input.userId,
        input.authRoot,
        input.randomBytes,
      );
      return { kind: "ok", ...rotated };
    }
    if (raced || isUniqueConstraintError(err)) return { kind: "invalid" };
    throw new Error("failed to persist session");
  }

  return { kind: "ok", sessionId, credential: formatCredential(sessionId, secret) };
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

  const row = await selectSession(db, "id = ?", presented.selector);
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
     SET revoked_at = ?, revocation_reason = ?
     WHERE id = ? AND revoked_at IS NULL`,
    toTimestamp(nowMs),
    reason,
    sessionId,
  );
}

export async function listSessionsForUser(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number; currentSessionId?: string },
): Promise<SessionListResult> {
  const rows = await db.all<SessionDbRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM sessions
     WHERE user_id = ?
     ORDER BY last_seen_at DESC, created_at DESC`,
    input.userId,
  );
  let activeCount = 0;
  const sessions = rows.map((raw): SessionListItem => {
    const row = toSessionRow(raw);
    const usable = sessionUsable(row, input.nowMs);
    if (usable) activeCount += 1;
    return {
      id: row.id,
      created_at_ms: row.created_at_ms,
      authenticated_at_ms: row.authenticated_at_ms,
      last_seen_at_ms: row.last_seen_at_ms,
      idle_expires_at_ms: row.idle_expires_at_ms,
      absolute_expires_at_ms: row.absolute_expires_at_ms,
      revoked_at_ms: row.revoked_at_ms,
      revocation_reason: row.revocation_reason,
      user_agent_label: row.user_agent_label,
      usable,
      current: input.currentSessionId != null && row.id === input.currentSessionId,
    };
  });
  return {
    sessions,
    session_cap_warning: activeCount >= MAX_ACTIVE_SESSIONS ? SESSION_CAP_WARNING : null,
  };
}

export async function refreshSessionAuthenticatedAt(
  db: ControlPlaneDb,
  input: { sessionId: string; userId: UserId; nowMs: number },
): Promise<{ kind: "ok"; sessionId: SessionId } | { kind: "invalid" }> {
  const sessionId = parseSessionId(input.sessionId);
  if (!sessionId) return { kind: "invalid" };
  const now = toTimestamp(input.nowMs);
  const result = await db.run(
    `UPDATE sessions
     SET authenticated_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL
       AND idle_expires_at > ? AND absolute_expires_at > ?`,
    now,
    sessionId,
    input.userId,
    now,
    now,
  );
  if (result.changes === 0) return { kind: "invalid" };
  return { kind: "ok", sessionId };
}

export async function revokeOwnedSession(
  db: ControlPlaneDb,
  input: { sessionId: string; userId: UserId; nowMs: number; reason: string },
): Promise<"ok" | "not_found"> {
  const sessionId = parseSessionId(input.sessionId);
  if (!sessionId) return "not_found";
  const row = await db.first<{ id: string; user_id: string; revoked_at: string | null }>(
    "SELECT id, user_id, revoked_at FROM sessions WHERE id = ?",
    sessionId,
  );
  if (!row || row.user_id !== input.userId) return "not_found";
  if (row.revoked_at == null) {
    await revokeSession(db, sessionId, input.nowMs, input.reason);
  }
  return "ok";
}

export async function revokeAllSessionsForUser(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number; reason?: string },
): Promise<number> {
  const result = await db.run(
    `UPDATE sessions
     SET revoked_at = ?, revocation_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL`,
    toTimestamp(input.nowMs),
    input.reason ?? "revoke_all",
    input.userId,
  );
  return result.changes;
}

function sessionUsable(
  row: { revoked_at_ms: number | null; idle_expires_at_ms: number; absolute_expires_at_ms: number },
  nowMs: number,
): boolean {
  return row.revoked_at_ms == null && row.idle_expires_at_ms > nowMs && row.absolute_expires_at_ms > nowMs;
}

async function touchLastSeen(db: ControlPlaneDb, row: SessionRow, nowMs: number): Promise<void> {
  if (nowMs - row.last_seen_at_ms < SESSION_LAST_SEEN_COALESCE_MS) return;
  try {
    await db.run(
      `UPDATE sessions
       SET last_seen_at = ?, idle_expires_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      toTimestamp(nowMs),
      toTimestamp(nowMs + SESSION_IDLE_TTL_MS),
      row.id,
    );
  } catch {
    // Auth still succeeds if the coalesce write fails.
  }
}

async function lookupSessionForClaim(
  db: ControlPlaneDb,
  userId: UserId,
  claimId: string,
): Promise<SessionRow | null> {
  return selectSession(db, "created_from_claim_id = ? AND user_id = ?", claimId, userId);
}

export async function sessionExistsForClaim(
  db: ControlPlaneDb,
  userId: UserId,
  claimId: string,
): Promise<boolean> {
  const row = await lookupSessionForClaim(db, userId, claimId);
  return row != null;
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
  const now = toTimestamp(nowMs);
  const active = await db.all<{ id: string }>(
    `SELECT id FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?
     ORDER BY last_seen_at ASC`,
    userId,
    now,
    now,
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
