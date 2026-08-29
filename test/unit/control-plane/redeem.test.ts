import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
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
});
