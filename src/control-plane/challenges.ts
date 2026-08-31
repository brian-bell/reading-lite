import {
  EMAIL_CHANGE_PURPOSE,
  LOGIN_PURPOSE,
  MAGIC_LINK_TTL_MS,
  type AuthChallengePurpose,
} from "./constants";
import { formatCredential, mintSecretHex, type RandomBytes } from "./credential";
import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import { isUniqueConstraintError, type ControlPlaneDb } from "./db";
import { resolveLoginEligibility } from "./eligibility";
import { mintChallengeId, type ChallengeId, type SessionId, type UserId, type UuidSource } from "./ids";

export interface IssueLoginChallengeInput {
  emailCanonical: string;
  emailDisplayRequested: string;
  nowMs: number;
  authRoot: AuthRoot;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
}

export type IssueLoginChallengeResult =
  | { kind: "issued"; challengeId: ChallengeId; credential: string; deliveryEmail: string }
  | { kind: "skipped" };

export async function issueLoginChallenge(
  db: ControlPlaneDb,
  input: IssueLoginChallengeInput,
): Promise<IssueLoginChallengeResult> {
  const eligibility = await resolveLoginEligibility(db, input.emailCanonical, input.nowMs);
  if (eligibility.kind === "ineligible") return { kind: "skipped" };

  const userId = eligibility.kind === "existing_user" ? eligibility.user.id : null;
  // Existing users always receive mail at the verified display address, never a
  // differently cased request. Invites keep the operator-entered display.
  const emailDisplay =
    eligibility.kind === "existing_user"
      ? eligibility.user.email_display
      : eligibility.source === "invite"
        ? eligibility.emailDisplay
        : input.emailDisplayRequested;
  const deliveryEmail = emailDisplay;

  const challengeId = mintChallengeId(input.newUuid);
  const secret = mintSecretHex(input.randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "magic_link"), secret);
  const expiresAtMs = input.nowMs + MAGIC_LINK_TTL_MS;

  const revoke = {
    sql: `UPDATE auth_challenges
          SET state = 'revoked'
          WHERE email_canonical = ? AND purpose = ? AND state IN ('issued', 'claimed')`,
    params: [input.emailCanonical, LOGIN_PURPOSE],
  };
  const insert = {
    sql: `INSERT INTO auth_challenges (
            id, purpose, email_canonical, email_display, user_id,
            secret_hmac, hash_key_version, issued_at_ms, expires_at_ms, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
    params: [
      challengeId,
      LOGIN_PURPOSE,
      input.emailCanonical,
      emailDisplay,
      userId,
      secretHmac,
      input.authRoot.version,
      input.nowMs,
      expiresAtMs,
    ],
  };

  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await db.batch([revoke, insert]);
      return {
        kind: "issued",
        challengeId,
        credential: formatCredential(challengeId, secret),
        deliveryEmail,
      };
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === attempts - 1) throw err;
    }
  }

  throw new Error("failed to persist login challenge");
}

export interface IssueEmailChangeChallengeInput {
  emailCanonical: string;
  emailDisplay: string;
  userId: UserId;
  sessionId: SessionId;
  nowMs: number;
  authRoot: AuthRoot;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
}

export async function issueEmailChangeChallenge(
  db: ControlPlaneDb,
  input: IssueEmailChangeChallengeInput,
): Promise<IssueLoginChallengeResult> {
  const challengeId = mintChallengeId(input.newUuid);
  const secret = mintSecretHex(input.randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "magic_link"), secret);
  const expiresAtMs = input.nowMs + MAGIC_LINK_TTL_MS;

  const revoke = {
    sql: `UPDATE auth_challenges
          SET state = 'revoked'
          WHERE purpose = ? AND state IN ('issued', 'claimed')
            AND (email_canonical = ? OR user_id = ?)`,
    params: [EMAIL_CHANGE_PURPOSE, input.emailCanonical, input.userId],
  };
  const insert = {
    sql: `INSERT INTO auth_challenges (
            id, purpose, email_canonical, email_display, user_id, bound_session_id,
            secret_hmac, hash_key_version, issued_at_ms, expires_at_ms, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
    params: [
      challengeId,
      EMAIL_CHANGE_PURPOSE,
      input.emailCanonical,
      input.emailDisplay,
      input.userId,
      input.sessionId,
      secretHmac,
      input.authRoot.version,
      input.nowMs,
      expiresAtMs,
    ],
  };

  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await db.batch([revoke, insert]);
      return {
        kind: "issued",
        challengeId,
        credential: formatCredential(challengeId, secret),
        deliveryEmail: input.emailDisplay,
      };
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === attempts - 1) throw err;
    }
  }

  throw new Error("failed to persist email-change challenge");
}

export async function lookupChallenge(
  db: ControlPlaneDb,
  challengeId: string,
): Promise<{
  id: string;
  purpose: AuthChallengePurpose;
  email_canonical: string;
  email_display: string;
  user_id: string | null;
  bound_session_id: string | null;
  secret_hmac: string;
  hash_key_version: number;
  issued_at_ms: number;
  expires_at_ms: number;
  state: string;
  claim_id: string | null;
  claimed_at_ms: number | null;
  consumed_at_ms: number | null;
  completed_user_id: string | null;
  completed_session_id: string | null;
} | null> {
  return db.first(
    `SELECT id, purpose, email_canonical, email_display, user_id, bound_session_id, secret_hmac, hash_key_version,
            issued_at_ms, expires_at_ms, state, claim_id, claimed_at_ms, consumed_at_ms,
            completed_user_id, completed_session_id
     FROM auth_challenges WHERE id = ?`,
    challengeId,
  );
}
