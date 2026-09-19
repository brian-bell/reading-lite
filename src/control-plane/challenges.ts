import {
  EMAIL_CHANGE_PURPOSE,
  LOGIN_PURPOSE,
  MAGIC_LINK_TTL_MS,
  type AuthChallengePurpose,
} from "./constants";
import { formatCredential, mintSecretHex, type RandomBytes } from "./credential";
import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import { isUniqueConstraintError, lockKey, type ControlPlaneDb, type SqlStatement } from "./db";
import { resolveLoginEligibility } from "./eligibility";
import { mintChallengeId, type ChallengeId, type SessionId, type UserId, type UuidSource } from "./ids";
import { fromTimestamp, toTimestamp } from "./pg-time";

// Newest-only issue: revoke the address's live challenges, then insert the
// new one, as one transaction under advisory locks. D1's single writer
// serialized two issues for one address; here the locks do, because the rows
// a first issue would lock FOR UPDATE do not exist yet. Email-change issue
// also revokes by user, so it takes the user's lock first (always before the
// address's, so two issuers cannot wait on each other). The partial unique
// index stays the last word: a violation retries in a fresh transaction.
async function issueNewestOnly(
  db: ControlPlaneDb,
  keys: readonly string[],
  statements: readonly SqlStatement[],
): Promise<boolean> {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await db.transaction(async (tx) => {
        for (const key of keys) await lockKey(tx, key);
        await tx.batch(statements);
      });
      return true;
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === attempts - 1) throw err;
    }
  }
  return false;
}

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
            secret_hmac, hash_key_version, issued_at, expires_at, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
    params: [
      challengeId,
      LOGIN_PURPOSE,
      input.emailCanonical,
      emailDisplay,
      userId,
      secretHmac,
      input.authRoot.version,
      toTimestamp(input.nowMs),
      toTimestamp(expiresAtMs),
    ],
  };

  if (!(await issueNewestOnly(db, [challengeAddressKey(LOGIN_PURPOSE, input.emailCanonical)], [revoke, insert]))) {
    throw new Error("failed to persist login challenge");
  }
  return {
    kind: "issued",
    challengeId,
    credential: formatCredential(challengeId, secret),
    deliveryEmail,
  };
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
            secret_hmac, hash_key_version, issued_at, expires_at, state
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
      toTimestamp(input.nowMs),
      toTimestamp(expiresAtMs),
    ],
  };

  const keys = [
    `auth_challenge:user:${input.userId}`,
    challengeAddressKey(EMAIL_CHANGE_PURPOSE, input.emailCanonical),
  ];
  if (!(await issueNewestOnly(db, keys, [revoke, insert]))) {
    throw new Error("failed to persist email-change challenge");
  }
  return {
    kind: "issued",
    challengeId,
    credential: formatCredential(challengeId, secret),
    deliveryEmail: input.emailDisplay,
  };
}

export function challengeAddressKey(purpose: AuthChallengePurpose, emailCanonical: string): string {
  return `auth_challenge:${purpose}:${emailCanonical}`;
}

export interface ChallengeRow {
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
}

type ChallengeDbRow = Omit<ChallengeRow, "issued_at_ms" | "expires_at_ms" | "claimed_at_ms" | "consumed_at_ms"> & {
  issued_at: string;
  expires_at: string;
  claimed_at: string | null;
  consumed_at: string | null;
};

// `forUpdate` locks the row for the caller's transaction: redeem holds it
// from its first read to its last write, so parallel redeems of one link run
// one after the other, as they did on D1's single writer.
export async function lookupChallenge(
  db: ControlPlaneDb,
  challengeId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ChallengeRow | null> {
  const row = await db.first<ChallengeDbRow>(
    `SELECT id, purpose, email_canonical, email_display, user_id, bound_session_id, secret_hmac, hash_key_version,
            issued_at, expires_at, state, claim_id, claimed_at, consumed_at,
            completed_user_id, completed_session_id
     FROM auth_challenges WHERE id = ?${opts.forUpdate ? " FOR UPDATE" : ""}`,
    challengeId,
  );
  if (!row) return null;
  const { issued_at, expires_at, claimed_at, consumed_at, ...rest } = row;
  return {
    ...rest,
    issued_at_ms: fromTimestamp(issued_at),
    expires_at_ms: fromTimestamp(expires_at),
    claimed_at_ms: fromTimestamp(claimed_at),
    consumed_at_ms: fromTimestamp(consumed_at),
  };
}
