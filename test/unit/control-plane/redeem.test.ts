import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import { MAGIC_LINK_TTL_MS, SESSION_COOKIE_NAME } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import { authenticateSession } from "../../../src/control-plane/sessions";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seeded() {
  const { raw, db } = openControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode: "invite_only",
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { raw, db };
}

describe("redeemLoginChallenge", () => {
  it("is idempotent for the same claimant and rejects a competing claimant", async () => {
    const { db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    const first = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_retry-one",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const retry = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_retry-one",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "test",
    });
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.sessionId).toBe(first.sessionId);

    const competing = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_other",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(competing.kind).toBe("conflict");
  });

  it("provisions an invited user and rechecks eligibility at redemption", async () => {
    const { raw, db } = await seeded();
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES ('invited@example.com', 'Invited@example.com', ?)`,
      toTimestamp(NOW_MS),
    );
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "invited@example.com",
      emailDisplayRequested: "invited@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    await raw.run("DELETE FROM signup_invites WHERE email_canonical = 'invited@example.com'");
    const denied = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_invite-1",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: null,
    });
    expect(denied.kind).toBe("forbidden");

    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES ('invited@example.com', 'Invited@example.com', ?)`,
      toTimestamp(NOW_MS),
    );
    const issuedAgain = await issueLoginChallenge(db, {
      emailCanonical: "invited@example.com",
      emailDisplayRequested: "invited@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(issuedAgain.kind).toBe("issued");
    if (issuedAgain.kind !== "issued") return;
    const ok = await redeemLoginChallenge(db, {
      credential: issuedAgain.credential,
      redemptionId: "clm_invite-2",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: null,
    });
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") return;
    const user = withMs(await raw.first(
      "SELECT email_display, status FROM users WHERE email_canonical = 'invited@example.com'",
    )) as { email_display: string; status: string };
    expect(user.email_display).toBe("Invited@example.com");
    expect(user.status).toBe("active");
  });

  it("rejects an expired or unknown secret without consuming a later challenge", async () => {
    const { raw, db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;
    const afterExpiry = NOW_MS + MAGIC_LINK_TTL_MS + 1;
    const expired = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_late",
      nowMs: afterExpiry,
      authRoot,
      userAgentLabel: null,
    });
    expect(expired.kind).toBe("invalid");

    const later = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: afterExpiry + 1,
      authRoot,
    });
    expect(later.kind).toBe("issued");
    if (later.kind !== "issued") return;
    // Right selector, wrong secret: the live row must survive the guess.
    const forged = await redeemLoginChallenge(db, {
      credential: `${later.challengeId}.${"0".repeat(64)}`,
      redemptionId: "clm_forged",
      nowMs: afterExpiry + 2,
      authRoot,
      userAgentLabel: null,
    });
    expect(forged.kind).toBe("invalid");
    expect(withMs(await raw.first("SELECT state FROM auth_challenges WHERE id = ?", later.challengeId))).toEqual({
      state: "issued",
    });
    expect(withMs(await raw.first("SELECT COUNT(*) AS n FROM sessions"))).toEqual({ n: 0 });

    const real = await redeemLoginChallenge(db, {
      credential: later.credential,
      redemptionId: "clm_real",
      nowMs: afterExpiry + 3,
      authRoot,
      userAgentLabel: null,
    });
    expect(real.kind).toBe("ok");
  });

  it("rejects the same credential+redemption_id after expiry without rotating the live session", async () => {
    const { raw, db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    const first = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_replay-1",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const hmacBefore = withMs(await raw.first(
      "SELECT secret_hmac FROM sessions WHERE id = ?",
      first.sessionId,
    )) as { secret_hmac: string };

    const replay = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_replay-1",
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
      authRoot,
      userAgentLabel: "test",
    });
    expect(replay.kind).toBe("invalid");

    const hmacAfter = withMs(await raw.first(
      "SELECT secret_hmac FROM sessions WHERE id = ?",
      first.sessionId,
    )) as { secret_hmac: string };
    expect(hmacAfter.secret_hmac).toBe(hmacBefore.secret_hmac);

    const stillLive = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${first.credential}`,
      authRoot,
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
    });
    expect(stillLive.kind).toBe("ok");
  });

  it("does not complete a claimed challenge after expiry", async () => {
    const { raw, db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    await raw.run(
      `UPDATE auth_challenges
         SET state = 'claimed', claim_id = ?, claimed_at = ?
         WHERE id = ?`,
      "clm_claimed1", toTimestamp(NOW_MS + 1), issued.challengeId,
    );

    const late = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_claimed1",
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
      authRoot,
      userAgentLabel: null,
    });
    expect(late.kind).toBe("invalid");
    const sessions = withMs(await raw.first("SELECT COUNT(*) AS n FROM sessions")) as { n: number };
    expect(sessions.n).toBe(0);
  });

  it("does not attach a reused redemption_id to another user's session", async () => {
    const { raw, db } = await seeded();
    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at)
         VALUES ('other@example.com', 'other@example.com', ?)`,
      toTimestamp(NOW_MS),
    );

    const founderIssued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(founderIssued.kind).toBe("issued");
    if (founderIssued.kind !== "issued") return;
    const founder = await redeemLoginChallenge(db, {
      credential: founderIssued.credential,
      redemptionId: "clm_reused-x",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "a",
    });
    expect(founder.kind).toBe("ok");
    if (founder.kind !== "ok") return;
    const hmacFounder = withMs(await raw.first(
      "SELECT secret_hmac FROM sessions WHERE id = ?",
      founder.sessionId,
    )) as { secret_hmac: string };

    const otherIssued = await issueLoginChallenge(db, {
      emailCanonical: "other@example.com",
      emailDisplayRequested: "other@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(otherIssued.kind).toBe("issued");
    if (otherIssued.kind !== "issued") return;
    const other = await redeemLoginChallenge(db, {
      credential: otherIssued.credential,
      redemptionId: "clm_reused-x",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "b",
    });
    expect(other.kind).toBe("ok");
    if (other.kind !== "ok") return;
    expect(other.sessionId).not.toBe(founder.sessionId);
    expect(other.userId).not.toBe(founder.userId);

    const hmacFounderAfter = withMs(await raw.first(
      "SELECT secret_hmac FROM sessions WHERE id = ?",
      founder.sessionId,
    )) as { secret_hmac: string };
    expect(hmacFounderAfter.secret_hmac).toBe(hmacFounder.secret_hmac);

    const stillFounder = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${founder.credential}`,
      authRoot,
      nowMs: NOW_MS + 3,
    });
    expect(stillFounder.kind).toBe("ok");
  });

  it("refreshes authenticated_at_ms on the current session instead of minting another row", async () => {
    const { raw, db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;
    const first = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_step_first",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "first",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok" || !first.sessionId) return;
    expect(first.credential).toBeTruthy();

    const next = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(next.kind).toBe("issued");
    if (next.kind !== "issued") return;
    const stepped = await redeemLoginChallenge(db, {
      credential: next.credential,
      redemptionId: "clm_step_up",
      nowMs: NOW_MS + 60_000,
      authRoot,
      userAgentLabel: "step",
      stepUpSessionId: first.sessionId,
    });
    expect(stepped.kind).toBe("ok");
    if (stepped.kind !== "ok") return;
    expect(stepped.sessionId).toBe(first.sessionId);
    expect(stepped.credential).toBeNull();
    const rows = withMs(await raw.all("SELECT id, authenticated_at FROM sessions")) as {
      id: string;
      authenticated_at_ms: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.sessionId);
    expect(rows[0]?.authenticated_at_ms).toBe(NOW_MS + 60_000);
  });

  it("pins a consumed step-up replay to completed_session_id when another same-user session is live", async () => {
    const { raw, db } = await seeded();
    const issuedA = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issuedA.kind).toBe("issued");
    if (issuedA.kind !== "issued") return;
    const sessionA = await redeemLoginChallenge(db, {
      credential: issuedA.credential,
      redemptionId: "clm_pin_a",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "a",
    });
    expect(sessionA.kind).toBe("ok");
    if (sessionA.kind !== "ok" || !sessionA.sessionId) return;

    const issuedB = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(issuedB.kind).toBe("issued");
    if (issuedB.kind !== "issued") return;
    const sessionB = await redeemLoginChallenge(db, {
      credential: issuedB.credential,
      redemptionId: "clm_pin_b",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "b",
    });
    expect(sessionB.kind).toBe("ok");
    if (sessionB.kind !== "ok" || !sessionB.sessionId) return;
    expect(sessionB.sessionId).not.toBe(sessionA.sessionId);

    const issuedStep = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(issuedStep.kind).toBe("issued");
    if (issuedStep.kind !== "issued") return;
    const stepped = await redeemLoginChallenge(db, {
      credential: issuedStep.credential,
      redemptionId: "clm_pin_step",
      nowMs: NOW_MS + 60_000,
      authRoot,
      userAgentLabel: "step",
      stepUpSessionId: sessionA.sessionId,
    });
    expect(stepped.kind).toBe("ok");
    if (stepped.kind !== "ok") return;
    expect(stepped.sessionId).toBe(sessionA.sessionId);
    expect(stepped.credential).toBeNull();

    const challengeBefore = withMs(await raw.first(
      "SELECT state, completed_session_id FROM auth_challenges WHERE id = ?",
      issuedStep.challengeId,
    )) as { state: string; completed_session_id: string };
    expect(challengeBefore.state).toBe("consumed");
    expect(challengeBefore.completed_session_id).toBe(sessionA.sessionId);

    const sessionBBefore = withMs(await raw.first(
      "SELECT authenticated_at FROM sessions WHERE id = ?",
      sessionB.sessionId,
    )) as { authenticated_at_ms: number };
    expect(sessionBBefore.authenticated_at_ms).toBe(NOW_MS + 1);

    const replay = await redeemLoginChallenge(db, {
      credential: issuedStep.credential,
      redemptionId: "clm_pin_step",
      nowMs: NOW_MS + 90_000,
      authRoot,
      userAgentLabel: "replay",
      stepUpSessionId: sessionB.sessionId,
    });
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") return;
    expect(replay.sessionId).toBe(sessionA.sessionId);
    expect(replay.credential).toBeNull();

    const challengeAfter = withMs(await raw.first(
      "SELECT completed_session_id FROM auth_challenges WHERE id = ?",
      issuedStep.challengeId,
    )) as { completed_session_id: string };
    expect(challengeAfter.completed_session_id).toBe(sessionA.sessionId);

    const sessionBAfter = withMs(await raw.first(
      "SELECT authenticated_at FROM sessions WHERE id = ?",
      sessionB.sessionId,
    )) as { authenticated_at_ms: number };
    expect(sessionBAfter.authenticated_at_ms).toBe(sessionBBefore.authenticated_at_ms);

    const sessionAAfter = withMs(await raw.first(
      "SELECT authenticated_at FROM sessions WHERE id = ?",
      sessionA.sessionId,
    )) as { authenticated_at_ms: number };
    expect(sessionAAfter.authenticated_at_ms).toBe(NOW_MS + 90_000);
  });
});
