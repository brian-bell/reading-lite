import { EMAIL_CHANGE_PURPOSE, LOGIN_PURPOSE, REDEMPTION_ID_RE } from "./constants";
import { parseCredential, type RandomBytes } from "./credential";
import type { AuthRoot } from "./crypto";
import { isUniqueConstraintError, type ControlPlaneDb, type SqlStatement } from "./db";
import { resolveLoginEligibility } from "./eligibility";
import { matchSecretHmac } from "./hmac-match";
import { parseChallengeId, parseSessionId, parseUserId, type SessionId, type UserId, type UuidSource } from "./ids";
import { lookupChallenge } from "./challenges";
import {
  ensureUserWithDefaults,
  issueSessionForClaim,
  refreshSessionAuthenticatedAt,
  sessionExistsForClaim,
} from "./sessions";

export type RedeemResult =
  | {
      kind: "ok";
      userId: UserId;
      sessionId: SessionId | null;
      credential: string | null;
      emailDisplay: string;
      securityNotify?: { emailCanonical: string; emailDisplay: string; kind: "email_changed" };
    }
  | { kind: "invalid" }
  | { kind: "conflict"; reason?: "claim" | "email_taken" }
  | { kind: "forbidden" };

export interface RedeemLoginInput {
  credential: string;
  redemptionId: string;
  nowMs: number;
  authRoot: AuthRoot;
  previousAuthRoot?: AuthRoot;
  userAgentLabel: string | null;
  /** When set, refresh this live session instead of inserting another row. */
  stepUpSessionId?: string;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
}

export function parseRedemptionId(raw: string): string | null {
  const value = raw.trim();
  return REDEMPTION_ID_RE.test(value) ? value : null;
}

function challengeExpired(challenge: { expires_at_ms: number }, nowMs: number): boolean {
  return challenge.expires_at_ms <= nowMs;
}

export async function redeemLoginChallenge(
  db: ControlPlaneDb,
  input: RedeemLoginInput,
): Promise<RedeemResult> {
  const presented = parseCredential(input.credential, parseChallengeId);
  if (!presented) return { kind: "invalid" };

  const challenge = await lookupChallenge(db, presented.selector);
  const match = await matchSecretHmac(
    presented.secret,
    challenge?.secret_hmac ?? null,
    input.authRoot,
    input.previousAuthRoot,
    "magic_link",
  );
  if (!challenge || !match.ok) return { kind: "invalid" };
  if (challenge.purpose !== LOGIN_PURPOSE && challenge.purpose !== EMAIL_CHANGE_PURPOSE) {
    return { kind: "invalid" };
  }
  if (challenge.state === "revoked") return { kind: "invalid" };
  if (challengeExpired(challenge, input.nowMs)) return { kind: "invalid" };

  if (challenge.state === "issued") {
    const claimed = await db.run(
      `UPDATE auth_challenges
       SET state = 'claimed', claim_id = ?, claimed_at_ms = ?
       WHERE id = ? AND state = 'issued' AND expires_at_ms > ?`,
      input.redemptionId,
      input.nowMs,
      challenge.id,
      input.nowMs,
    );
    if (claimed.changes === 0) {
      const latest = await lookupChallenge(db, challenge.id);
      return resumeOrConflict(db, latest, input);
    }
  } else if (challenge.state === "claimed" || challenge.state === "consumed") {
    if (challenge.claim_id !== input.redemptionId) return { kind: "conflict" };
  } else {
    return { kind: "invalid" };
  }

  return completeRedemption(db, challenge.id, input);
}

async function resumeOrConflict(
  db: ControlPlaneDb,
  challenge: Awaited<ReturnType<typeof lookupChallenge>>,
  input: RedeemLoginInput,
): Promise<RedeemResult> {
  if (!challenge) return { kind: "invalid" };
  if (challenge.state === "revoked" || challengeExpired(challenge, input.nowMs)) return { kind: "invalid" };
  if (challenge.claim_id && challenge.claim_id !== input.redemptionId) return { kind: "conflict" };
  if (challenge.state === "claimed" || challenge.state === "consumed") {
    return completeRedemption(db, challenge.id, input);
  }
  return { kind: "invalid" };
}

async function completeRedemption(
  db: ControlPlaneDb,
  challengeId: string,
  input: RedeemLoginInput,
): Promise<RedeemResult> {
  const challenge = await lookupChallenge(db, challengeId);
  if (!challenge) return { kind: "invalid" };
  if (challengeExpired(challenge, input.nowMs)) return { kind: "invalid" };
  if (challenge.claim_id && challenge.claim_id !== input.redemptionId) return { kind: "conflict" };
  if (challenge.state === "revoked") return { kind: "invalid" };
  if (challenge.state !== "claimed" && challenge.state !== "consumed") return { kind: "invalid" };
  if (challenge.purpose === EMAIL_CHANGE_PURPOSE) {
    return completeEmailChange(db, challenge, input);
  }
  if (challenge.purpose !== LOGIN_PURPOSE) return { kind: "invalid" };

  const eligibility = await resolveLoginEligibility(db, challenge.email_canonical, input.nowMs);
  if (eligibility.kind === "ineligible") return { kind: "forbidden" };

  const emailDisplay =
    eligibility.kind === "existing_user" ? eligibility.user.email_display : challenge.email_display;

  const userId = await ensureUserWithDefaults(db, {
    emailCanonical: challenge.email_canonical,
    emailDisplay,
    nowMs: input.nowMs,
    newUuid: input.newUuid,
  });

  // Consumed replay is pinned to the original completed session. A live cookie
  // for a different same-user session must not refresh or overwrite that row.
  // Step-up writes completed_session_id without a sessions row for this claim;
  // replaying the same redemption must resume that row, not insert (and LRU).
  if (challenge.state === "consumed" && challenge.completed_session_id) {
    const mintedForClaim = await sessionExistsForClaim(db, userId, input.redemptionId);
    if (!mintedForClaim) {
      const resumed = await refreshSessionAuthenticatedAt(db, {
        sessionId: challenge.completed_session_id,
        userId,
        nowMs: input.nowMs,
      });
      if (resumed.kind !== "ok") return { kind: "invalid" };
      return {
        kind: "ok",
        userId,
        sessionId: resumed.sessionId,
        credential: null,
        emailDisplay,
      };
    }
  } else if (input.stepUpSessionId && challenge.state === "claimed") {
    const refreshed = await refreshSessionAuthenticatedAt(db, {
      sessionId: input.stepUpSessionId,
      userId,
      nowMs: input.nowMs,
    });
    if (refreshed.kind === "ok") {
      await consumeChallenge(db, {
        challengeId: challenge.id,
        redemptionId: input.redemptionId,
        nowMs: input.nowMs,
        userId,
        sessionId: refreshed.sessionId,
        emailCanonical: challenge.email_canonical,
      });
      return {
        kind: "ok",
        userId,
        sessionId: refreshed.sessionId,
        credential: null,
        emailDisplay,
      };
    }
  }

  const session = await issueSessionForClaim(db, {
    userId,
    claimId: input.redemptionId,
    nowMs: input.nowMs,
    authRoot: input.authRoot,
    userAgentLabel: input.userAgentLabel,
    randomBytes: input.randomBytes,
    newUuid: input.newUuid,
  });
  if (session.kind !== "ok") return { kind: "invalid" };

  await consumeChallenge(db, {
    challengeId: challenge.id,
    redemptionId: input.redemptionId,
    nowMs: input.nowMs,
    userId,
    sessionId: session.sessionId,
    emailCanonical: challenge.email_canonical,
  });

  return {
    kind: "ok",
    userId,
    sessionId: session.sessionId,
    credential: session.credential,
    emailDisplay,
  };
}

type ChallengeRow = NonNullable<Awaited<ReturnType<typeof lookupChallenge>>>;

async function completeEmailChange(
  db: ControlPlaneDb,
  challenge: ChallengeRow,
  input: RedeemLoginInput,
): Promise<RedeemResult> {
  const userId = challenge.user_id ? parseUserId(challenge.user_id) : null;
  if (!userId) return { kind: "invalid" };

  const user = await db.first<{
    email_canonical: string;
    email_display: string;
    status: string;
  }>("SELECT email_canonical, email_display, status FROM users WHERE id = ?", userId);
  if (!user) return { kind: "invalid" };
  if (user.status !== "active") return { kind: "forbidden" };

  const confirmingSessionId = await confirmingSessionForUser(db, {
    sessionId: input.stepUpSessionId,
    userId,
    nowMs: input.nowMs,
  });

  if (challenge.state === "consumed") {
    return {
      kind: "ok",
      userId,
      sessionId: confirmingSessionId,
      credential: null,
      emailDisplay: challenge.email_display,
    };
  }

  const alreadySwapped = user.email_canonical === challenge.email_canonical;
  const oldEmailCanonical = user.email_canonical;
  const oldEmailDisplay = user.email_display;

  const revokeSessions: SqlStatement = confirmingSessionId
    ? {
        sql: `UPDATE sessions
              SET revoked_at_ms = ?, revocation_reason = ?
              WHERE user_id = ? AND revoked_at_ms IS NULL AND id != ?`,
        params: [input.nowMs, "email_change", userId, confirmingSessionId],
      }
    : {
        sql: `UPDATE sessions
              SET revoked_at_ms = ?, revocation_reason = ?
              WHERE user_id = ? AND revoked_at_ms IS NULL`,
        params: [input.nowMs, "email_change", userId],
      };
  const revokeTokens: SqlStatement = {
    sql: `UPDATE api_tokens SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL`,
    params: [input.nowMs, userId],
  };
  const consume: SqlStatement = {
    sql: `UPDATE auth_challenges
          SET state = 'consumed',
              consumed_at_ms = COALESCE(consumed_at_ms, ?),
              completed_user_id = ?,
              completed_session_id = ?
          WHERE id = ? AND claim_id = ? AND state IN ('claimed', 'consumed')`,
    params: [input.nowMs, userId, confirmingSessionId, challenge.id, input.redemptionId],
  };

  // Crash after swap but before consume: retry sees the new canonical, must not
  // notify that inbox. Skip swap+mail and only finish revoke/consume.
  if (alreadySwapped) {
    await db.batch([revokeSessions, revokeTokens, consume]);
    return {
      kind: "ok",
      userId,
      sessionId: confirmingSessionId,
      credential: null,
      emailDisplay: challenge.email_display,
    };
  }

  try {
    await db.batch([
      {
        sql: `UPDATE users
              SET email_canonical = ?, email_display = ?, email_verified_at_ms = ?, updated_at_ms = ?
              WHERE id = ? AND status = 'active'`,
        params: [
          challenge.email_canonical,
          challenge.email_display,
          input.nowMs,
          input.nowMs,
          userId,
        ],
      },
      revokeSessions,
      revokeTokens,
      consume,
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      await burnEmailChangeChallenge(db, challenge.id);
      return { kind: "conflict", reason: "email_taken" };
    }
    throw err;
  }

  return {
    kind: "ok",
    userId,
    sessionId: confirmingSessionId,
    credential: null,
    emailDisplay: challenge.email_display,
    securityNotify: {
      emailCanonical: oldEmailCanonical,
      emailDisplay: oldEmailDisplay,
      kind: "email_changed",
    },
  };
}

async function confirmingSessionForUser(
  db: ControlPlaneDb,
  input: { sessionId: string | undefined; userId: UserId; nowMs: number },
): Promise<SessionId | null> {
  if (!input.sessionId) return null;
  const sessionId = parseSessionId(input.sessionId);
  if (!sessionId) return null;
  const row = await db.first<{ id: string }>(
    `SELECT id FROM sessions
     WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
       AND idle_expires_at_ms > ? AND absolute_expires_at_ms > ?`,
    sessionId,
    input.userId,
    input.nowMs,
    input.nowMs,
  );
  return row ? sessionId : null;
}

async function burnEmailChangeChallenge(db: ControlPlaneDb, challengeId: string): Promise<void> {
  await db.run(
    `UPDATE auth_challenges SET state = 'revoked' WHERE id = ? AND state IN ('issued', 'claimed')`,
    challengeId,
  );
}

async function consumeChallenge(
  db: ControlPlaneDb,
  input: {
    challengeId: string;
    redemptionId: string;
    nowMs: number;
    userId: UserId;
    sessionId: SessionId;
    emailCanonical: string;
  },
): Promise<void> {
  await db.batch([
    {
      sql: `UPDATE auth_challenges
            SET state = 'consumed',
                consumed_at_ms = COALESCE(consumed_at_ms, ?),
                completed_user_id = ?,
                completed_session_id = ?
            WHERE id = ? AND claim_id = ? AND state IN ('claimed', 'consumed')`,
      params: [input.nowMs, input.userId, input.sessionId, input.challengeId, input.redemptionId],
    },
    {
      sql: `UPDATE signup_invites
            SET consumed_at_ms = COALESCE(consumed_at_ms, ?)
            WHERE email_canonical = ? AND consumed_at_ms IS NULL`,
      params: [input.nowMs, input.emailCanonical],
    },
  ]);
}
