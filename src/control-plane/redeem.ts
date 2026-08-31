import { LOGIN_PURPOSE, REDEMPTION_ID_RE } from "./constants";
import { parseCredential, type RandomBytes } from "./credential";
import type { AuthRoot } from "./crypto";
import type { ControlPlaneDb } from "./db";
import { resolveLoginEligibility } from "./eligibility";
import { matchSecretHmac } from "./hmac-match";
import { parseChallengeId, type SessionId, type UserId, type UuidSource } from "./ids";
import { lookupChallenge } from "./challenges";
import { ensureUserWithDefaults, issueSessionForClaim, refreshSessionAuthenticatedAt } from "./sessions";

export type RedeemResult =
  | { kind: "ok"; userId: UserId; sessionId: SessionId; credential: string | null; emailDisplay: string }
  | { kind: "invalid" }
  | { kind: "conflict" }
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
  if (challenge.purpose !== LOGIN_PURPOSE) return { kind: "invalid" };
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

  if (input.stepUpSessionId) {
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
