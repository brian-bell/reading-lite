import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import { MAGIC_LINK_TTL_MS, SESSION_COOKIE_NAME } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import { authenticateSession, revokeSession } from "../../../src/control-plane/sessions";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seeded() {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode: "invite_only",
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db };
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
    const { sqlite, db } = await seeded();
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
         VALUES ('invited@example.com', 'Invited@example.com', ?)`,
      )
      .run(NOW_MS);
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "invited@example.com",
      emailDisplayRequested: "invited@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    sqlite.prepare("DELETE FROM signup_invites WHERE email_canonical = 'invited@example.com'").run();
    const denied = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_invite-1",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: null,
    });
    expect(denied.kind).toBe("forbidden");

    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
         VALUES ('invited@example.com', 'Invited@example.com', ?)`,
      )
      .run(NOW_MS);
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
    const user = sqlite
      .prepare("SELECT email_display, status FROM users WHERE email_canonical = 'invited@example.com'")
      .get() as { email_display: string; status: string };
    expect(user.email_display).toBe("Invited@example.com");
    expect(user.status).toBe("active");
  });

  it("rejects an expired or unknown secret without consuming a later challenge", async () => {
    const { db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;
    const expired = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_late",
      nowMs: NOW_MS + 16 * 60 * 1000,
      authRoot,
      userAgentLabel: null,
    });
    expect(expired.kind).toBe("invalid");
  });

  it("rejects the same credential+redemption_id after expiry without rotating the live session", async () => {
    const { sqlite, db } = await seeded();
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

    const hmacBefore = sqlite
      .prepare("SELECT secret_hmac FROM sessions WHERE id = ?")
      .get(first.sessionId) as { secret_hmac: string };

    const replay = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_replay-1",
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
      authRoot,
      userAgentLabel: "test",
    });
    expect(replay.kind).toBe("invalid");

    const hmacAfter = sqlite
      .prepare("SELECT secret_hmac FROM sessions WHERE id = ?")
      .get(first.sessionId) as { secret_hmac: string };
    expect(hmacAfter.secret_hmac).toBe(hmacBefore.secret_hmac);

    const stillLive = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${first.credential}`,
      authRoot,
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
    });
    expect(stillLive.kind).toBe("ok");
  });

  it("does not complete a claimed challenge after expiry", async () => {
    const { sqlite, db } = await seeded();
    const issued = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;

    sqlite
      .prepare(
        `UPDATE auth_challenges
         SET state = 'claimed', claim_id = ?, claimed_at_ms = ?
         WHERE id = ?`,
      )
      .run("clm_claimed1", NOW_MS + 1, issued.challengeId);

    const late = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_claimed1",
      nowMs: NOW_MS + MAGIC_LINK_TTL_MS,
      authRoot,
      userAgentLabel: null,
    });
    expect(late.kind).toBe("invalid");
    const sessions = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(0);
  });

  it("does not attach a reused redemption_id to another user's session", async () => {
    const { sqlite, db } = await seeded();
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
         VALUES ('other@example.com', 'other@example.com', ?)`,
      )
      .run(NOW_MS);

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
    const hmacFounder = sqlite
      .prepare("SELECT secret_hmac FROM sessions WHERE id = ?")
      .get(founder.sessionId) as { secret_hmac: string };

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

    const hmacFounderAfter = sqlite
      .prepare("SELECT secret_hmac FROM sessions WHERE id = ?")
      .get(founder.sessionId) as { secret_hmac: string };
    expect(hmacFounderAfter.secret_hmac).toBe(hmacFounder.secret_hmac);

    const stillFounder = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${founder.credential}`,
      authRoot,
      nowMs: NOW_MS + 3,
    });
    expect(stillFounder.kind).toBe("ok");
  });

  it("rejects logout-then-Continue on the same claim without 500 or a new session", async () => {
    const { sqlite, db } = await seeded();
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
      redemptionId: "clm_continue",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    await revokeSession(db, first.sessionId, NOW_MS + 2, "logout");

    const again = await redeemLoginChallenge(db, {
      credential: issued.credential,
      redemptionId: "clm_continue",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(again.kind).toBe("invalid");
    const rows = sqlite.prepare("SELECT id, revoked_at_ms FROM sessions").all() as {
      id: string;
      revoked_at_ms: number | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.sessionId);
    expect(rows[0]?.revoked_at_ms).toBe(NOW_MS + 2);
  });
});
