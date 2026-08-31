import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueEmailChangeChallenge, issueLoginChallenge } from "../../../src/control-plane/challenges";
import { MAGIC_LINK_TTL_MS, SESSION_COOKIE_NAME } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { parseUserId, type SessionId, type UserId } from "../../../src/control-plane/ids";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import {
  authenticateSession,
  ensureUserWithDefaults,
  issueSessionForClaim,
} from "../../../src/control-plane/sessions";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
const FOUNDER_ID = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!;

async function seeded() {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode: "closed",
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db };
}

async function loginFounder(db: ControlPlaneDb, redemptionId: string) {
  const issued = await issueLoginChallenge(db, {
    emailCanonical: "founder@example.com",
    emailDisplayRequested: "founder@example.com",
    nowMs: NOW_MS,
    authRoot,
  });
  if (issued.kind !== "issued") throw new Error("expected login challenge");
  const redeemed = await redeemLoginChallenge(db, {
    credential: issued.credential,
    redemptionId,
    nowMs: NOW_MS + 1,
    authRoot,
    userAgentLabel: "test",
  });
  if (redeemed.kind !== "ok" || !redeemed.sessionId || !redeemed.credential) {
    throw new Error("expected login session");
  }
  return redeemed;
}

async function liveSession(db: ControlPlaneDb, userId: UserId, claimId: string, nowMs = NOW_MS) {
  const session = await issueSessionForClaim(db, {
    userId,
    claimId,
    nowMs,
    authRoot,
    userAgentLabel: "test",
  });
  if (session.kind !== "ok") throw new Error("expected live session");
  return session;
}

function withConfirmingSession(sessionId: SessionId | string) {
  return { sessionCookiePresent: true as const, stepUpSessionId: String(sessionId) };
}

describe("email-change redeem", () => {
  it("swaps canonical email, keeps the confirming session, and revokes others plus api tokens", async () => {
    const { sqlite, db } = await seeded();
    const first = await loginFounder(db, "clm_keep");
    const other = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(other.kind).toBe("issued");
    if (other.kind !== "issued") return;
    const second = await redeemLoginChallenge(db, {
      credential: other.credential,
      redemptionId: "clm_other_session",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "other",
    });
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok" || !second.credential) return;

    const change = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "New@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(change.kind).toBe("issued");
    if (change.kind !== "issued") return;

    const confirmed = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_email_ok",
      nowMs: NOW_MS + 5,
      authRoot,
      userAgentLabel: "confirm",
      ...withConfirmingSession(first.sessionId!),
    });
    expect(confirmed.kind).toBe("ok");
    if (confirmed.kind !== "ok") return;
    expect(confirmed.credential).toBeNull();
    expect(confirmed.sessionId).toBe(first.sessionId);
    expect(confirmed.emailDisplay).toBe("New@example.com");
    expect(confirmed.securityNotify).toEqual({
      emailCanonical: "founder@example.com",
      emailDisplay: "Founder@Example.com",
      kind: "email_changed",
    });

    const user = sqlite
      .prepare("SELECT email_canonical, email_display, email_verified_at_ms FROM users WHERE id = ?")
      .get(FOUNDER_ID) as { email_canonical: string; email_display: string; email_verified_at_ms: number };
    expect(user).toEqual({
      email_canonical: "new@example.com",
      email_display: "New@example.com",
      email_verified_at_ms: NOW_MS + 5,
    });

    const sessions = sqlite
      .prepare("SELECT id, revoked_at_ms, revocation_reason FROM sessions")
      .all() as { id: string; revoked_at_ms: number | null; revocation_reason: string | null }[];
    expect(sessions.find((row) => row.id === first.sessionId)?.revoked_at_ms).toBeNull();
    expect(sessions.find((row) => row.id === second.sessionId)).toMatchObject({
      revoked_at_ms: NOW_MS + 5,
      revocation_reason: "email_change",
    });

    const tokens = sqlite.prepare("SELECT revoked_at_ms FROM api_tokens").all() as { revoked_at_ms: number | null }[];
    expect(tokens.every((row) => row.revoked_at_ms === NOW_MS + 5)).toBe(true);

    const kept = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${first.credential}`,
      authRoot,
      nowMs: NOW_MS + 5,
    });
    expect(kept.kind).toBe("ok");

    const otherAuth = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${second.credential}`,
      authRoot,
      nowMs: NOW_MS + 5,
    });
    expect(otherAuth.kind).toBe("unauthenticated");
  });

  it("does not swap, consume, or revoke when redeem is cookie-less", async () => {
    const { sqlite, db } = await seeded();
    const first = await loginFounder(db, "clm_cookie_less_keep");
    const change = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "New@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(change.kind).toBe("issued");
    if (change.kind !== "issued") return;

    const denied = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_cookie_less",
      nowMs: NOW_MS + 5,
      authRoot,
      userAgentLabel: "other-device",
      sessionCookiePresent: false,
    });
    expect(denied.kind).toBe("unauthenticated");
    expect(
      sqlite.prepare("SELECT email_canonical FROM users WHERE id = ?").get(FOUNDER_ID),
    ).toEqual({ email_canonical: "founder@example.com" });
    expect(
      sqlite.prepare("SELECT state, claim_id FROM auth_challenges WHERE id = ?").get(change.challengeId),
    ).toEqual({ state: "issued", claim_id: null });
    expect(
      sqlite.prepare("SELECT revoked_at_ms FROM sessions WHERE id = ?").get(first.sessionId),
    ).toEqual({ revoked_at_ms: null });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at_ms IS NULL").get(),
    ).toEqual({ n: 1 });
  });

  it("does not swap when a different live session presents the link", async () => {
    const { sqlite, db } = await seeded();
    const first = await loginFounder(db, "clm_bound");
    const other = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(other.kind).toBe("issued");
    if (other.kind !== "issued") return;
    const second = await redeemLoginChallenge(db, {
      credential: other.credential,
      redemptionId: "clm_other_device",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "other",
    });
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok" || !second.sessionId) return;

    const change = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "New@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(change.kind).toBe("issued");
    if (change.kind !== "issued") return;

    const denied = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_wrong_session",
      nowMs: NOW_MS + 5,
      authRoot,
      userAgentLabel: "other",
      ...withConfirmingSession(second.sessionId),
    });
    expect(denied.kind).toBe("forbidden");
    expect(
      sqlite.prepare("SELECT email_canonical FROM users WHERE id = ?").get(FOUNDER_ID),
    ).toEqual({ email_canonical: "founder@example.com" });
    expect(
      sqlite.prepare("SELECT state, claim_id FROM auth_challenges WHERE id = ?").get(change.challengeId),
    ).toEqual({ state: "issued", claim_id: null });
  });

  it("is idempotent for the same claimant and rejects a competing claimant", async () => {
    const { db } = await seeded();
    const firstSession = await loginFounder(db, "clm_keep_idem");
    const change = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "new@example.com",
      userId: FOUNDER_ID,
      sessionId: firstSession.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(change.kind).toBe("issued");
    if (change.kind !== "issued") return;
    const first = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_retry",
      nowMs: NOW_MS + 5,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(firstSession.sessionId!),
    });
    expect(first.kind).toBe("ok");
    const retry = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_retry",
      nowMs: NOW_MS + 6,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(firstSession.sessionId!),
    });
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.securityNotify).toBeUndefined();

    const competing = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_other",
      nowMs: NOW_MS + 7,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(firstSession.sessionId!),
    });
    expect(competing.kind).toBe("conflict");
  });

  it("rejects consumed, revoked, and expired challenges without swapping", async () => {
    const { sqlite, db } = await seeded();
    const first = await loginFounder(db, "clm_reject_keep");
    const issued = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "new@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    sqlite.prepare("UPDATE auth_challenges SET state = 'revoked' WHERE id = ?").run(issued.challengeId);
    const revoked = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_revoked",
      nowMs: NOW_MS + 5,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(first.sessionId!),
    });
    expect(revoked.kind).toBe("invalid");

    const fresh = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "new@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 6,
      authRoot,
    });
    expect(fresh.kind).toBe("issued");
    if (fresh.kind !== "issued") return;
    const expired = await redeemLoginChallenge(db, {
      credential: fresh.credential,
      redemptionId: "clm_expired",
      nowMs: NOW_MS + 6 + MAGIC_LINK_TTL_MS,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(first.sessionId!),
    });
    expect(expired.kind).toBe("invalid");

    const user = sqlite
      .prepare("SELECT email_canonical FROM users WHERE id = ?")
      .get(FOUNDER_ID) as { email_canonical: string };
    expect(user.email_canonical).toBe("founder@example.com");
  });

  it("does not notify the new inbox when swap already applied but consume did not stick", async () => {
    const { sqlite, db } = await seeded();
    const first = await loginFounder(db, "clm_partial_keep");
    const otherLogin = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(otherLogin.kind).toBe("issued");
    if (otherLogin.kind !== "issued") return;
    const second = await redeemLoginChallenge(db, {
      credential: otherLogin.credential,
      redemptionId: "clm_partial_other",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "other",
    });
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok" || !second.credential) return;

    const change = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "New@example.com",
      userId: FOUNDER_ID,
      sessionId: first.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    expect(change.kind).toBe("issued");
    if (change.kind !== "issued") return;
    sqlite
      .prepare(
        `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at_ms = ? WHERE id = ?`,
      )
      .run("clm_partial", NOW_MS + 5, change.challengeId);
    sqlite
      .prepare(
        `UPDATE users SET email_canonical = ?, email_display = ?, email_verified_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run("new@example.com", "New@example.com", NOW_MS + 5, NOW_MS + 5, FOUNDER_ID);

    const retry = await redeemLoginChallenge(db, {
      credential: change.credential,
      redemptionId: "clm_partial",
      nowMs: NOW_MS + 6,
      authRoot,
      userAgentLabel: "confirm",
      ...withConfirmingSession(first.sessionId!),
    });
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.securityNotify).toBeUndefined();
    expect(retry.emailDisplay).toBe("New@example.com");
    expect(
      sqlite.prepare("SELECT state, consumed_at_ms FROM auth_challenges WHERE id = ?").get(change.challengeId),
    ).toEqual({ state: "consumed", consumed_at_ms: NOW_MS + 6 });
    expect(
      sqlite.prepare("SELECT email_canonical, email_display FROM users WHERE id = ?").get(FOUNDER_ID),
    ).toEqual({ email_canonical: "new@example.com", email_display: "New@example.com" });
    expect(
      sqlite.prepare("SELECT revoked_at_ms FROM sessions WHERE id = ?").get(first.sessionId),
    ).toEqual({ revoked_at_ms: null });
    expect(
      sqlite.prepare("SELECT revocation_reason FROM sessions WHERE id = ?").get(second.sessionId),
    ).toEqual({ revocation_reason: "email_change" });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at_ms IS NULL").get(),
    ).toEqual({ n: 0 });

    const competitorId = await ensureUserWithDefaults(db, {
      emailCanonical: "other@example.com",
      emailDisplay: "other@example.com",
      nowMs: NOW_MS + 7,
      newUuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const competitorSession = await liveSession(db, competitorId, "clm_competitor_session", NOW_MS + 8);
    const competing = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "new@example.com",
      userId: competitorId,
      sessionId: competitorSession.sessionId,
      nowMs: NOW_MS + 9,
      authRoot,
    });
    expect(competing.kind).toBe("issued");
    if (competing.kind !== "issued") return;
    const taken = await redeemLoginChallenge(db, {
      credential: competing.credential,
      redemptionId: "clm_partial_taken",
      nowMs: NOW_MS + 10,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(competitorSession.sessionId),
    });
    expect(taken).toEqual({ kind: "conflict", reason: "email_taken" });
    expect(
      sqlite.prepare("SELECT email_canonical FROM users WHERE id = ?").get(competitorId),
    ).toEqual({ email_canonical: "other@example.com" });
  });

  it("fail-closes when the new address is taken and on a uniqueness race", async () => {
    const { sqlite, db } = await seeded();
    const founderSession = await loginFounder(db, "clm_founder_race");
    const otherId = await ensureUserWithDefaults(db, {
      emailCanonical: "taken@example.com",
      emailDisplay: "taken@example.com",
      nowMs: NOW_MS,
      newUuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const otherSession = await liveSession(db, otherId, "clm_other_live", NOW_MS + 1);

    const occupied = await issueEmailChangeChallenge(db, {
      emailCanonical: "taken@example.com",
      emailDisplay: "taken@example.com",
      userId: FOUNDER_ID,
      sessionId: founderSession.sessionId!,
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(occupied.kind).toBe("issued");
    if (occupied.kind !== "issued") return;
    const denied = await redeemLoginChallenge(db, {
      credential: occupied.credential,
      redemptionId: "clm_taken",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: null,
      ...withConfirmingSession(founderSession.sessionId!),
    });
    expect(denied).toEqual({ kind: "conflict", reason: "email_taken" });
    expect(
      sqlite.prepare("SELECT email_canonical FROM users WHERE id = ?").get(FOUNDER_ID),
    ).toEqual({ email_canonical: "founder@example.com" });
    expect(
      sqlite.prepare("SELECT state FROM auth_challenges WHERE id = ?").get(occupied.challengeId),
    ).toEqual({ state: "revoked" });

    sqlite.prepare("UPDATE users SET email_canonical = 'other@example.com' WHERE id = ?").run(otherId);
    const founderChange = await issueEmailChangeChallenge(db, {
      emailCanonical: "race@example.com",
      emailDisplay: "race@example.com",
      userId: FOUNDER_ID,
      sessionId: founderSession.sessionId!,
      nowMs: NOW_MS + 4,
      authRoot,
    });
    const otherChange = await issueEmailChangeChallenge(db, {
      emailCanonical: "other-new@example.com",
      emailDisplay: "other-new@example.com",
      userId: otherId,
      sessionId: otherSession.sessionId,
      nowMs: NOW_MS + 5,
      authRoot,
    });
    expect(founderChange.kind).toBe("issued");
    expect(otherChange.kind).toBe("issued");
    if (founderChange.kind !== "issued" || otherChange.kind !== "issued") return;

    sqlite
      .prepare(
        `UPDATE auth_challenges SET state = 'claimed', claim_id = ? WHERE id = ?`,
      )
      .run("clm_race_a", founderChange.challengeId);
    sqlite
      .prepare(
        `UPDATE auth_challenges
         SET email_canonical = 'race@example.com', email_display = 'race@example.com',
             state = 'claimed', claim_id = ?
         WHERE id = ?`,
      )
      .run("clm_race_b", otherChange.challengeId);

    const racing = twoUpdateRaceDb(db);
    const [first, second] = await Promise.all([
      redeemLoginChallenge(racing, {
        credential: founderChange.credential,
        redemptionId: "clm_race_a",
        nowMs: NOW_MS + 6,
        authRoot,
        userAgentLabel: null,
        ...withConfirmingSession(founderSession.sessionId!),
      }),
      redeemLoginChallenge(racing, {
        credential: otherChange.credential,
        redemptionId: "clm_race_b",
        nowMs: NOW_MS + 7,
        authRoot,
        userAgentLabel: null,
        ...withConfirmingSession(otherSession.sessionId),
      }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["conflict", "ok"]);
    const taken = sqlite
      .prepare("SELECT COUNT(*) AS n FROM users WHERE email_canonical = 'race@example.com'")
      .get() as { n: number };
    expect(taken.n).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
  });
});

function twoUpdateRaceDb(inner: ControlPlaneDb): ControlPlaneDb {
  let started = 0;
  let releaseFirst: (() => void) | undefined;
  let firstWaiting: Promise<void> | undefined;

  async function gateUserEmailUpdate(): Promise<void> {
    started += 1;
    if (started === 1) {
      firstWaiting = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      await firstWaiting;
    } else if (started === 2) {
      releaseFirst?.();
    }
  }

  function isUserEmailUpdate(sql: string): boolean {
    return /UPDATE users/i.test(sql) && /email_canonical/i.test(sql);
  }

  return {
    first: (sql, ...params) => inner.first(sql, ...params),
    all: (sql, ...params) => inner.all(sql, ...params),
    async batch(statements) {
      if (statements.some((statement) => isUserEmailUpdate(statement.sql))) {
        await gateUserEmailUpdate();
      }
      return inner.batch(statements);
    },
    async run(sql, ...params) {
      if (isUserEmailUpdate(sql)) await gateUserEmailUpdate();
      return inner.run(sql, ...params);
    },
  };
}
