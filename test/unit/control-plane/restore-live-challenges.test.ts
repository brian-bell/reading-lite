import { describe, expect, it } from "vitest";
import { restoreLiveChallenges } from "../../../src/control-plane/auth-handlers";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueEmailChangeChallenge, issueLoginChallenge } from "../../../src/control-plane/challenges";
import { EMAIL_CHANGE_PURPOSE } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseUserId } from "../../../src/control-plane/ids";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import { ensureUserWithDefaults, issueSessionForClaim } from "../../../src/control-plane/sessions";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";
import type { ControlPlaneDb } from "../../../src/control-plane/db";

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

async function challengeStates(raw: ControlPlaneDb) {
  return raw.all<{ id: string; state: string }>("SELECT id, state FROM auth_challenges ORDER BY issue_seq");
}

async function markMailSent(
  raw: ControlPlaneDb,
  challengeId: string,
  atMs: number,
): Promise<void> {
  await raw.run("UPDATE auth_challenges SET mail_sent_at = ? WHERE id = ?", toTimestamp(atMs), challengeId);
}

describe("restoreLiveChallenges", () => {
  it("does not revive a predecessor that was consumed before issue revoked it", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    await markMailSent(raw, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued" }];

    const consumed = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_consumed_pred",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(consumed.kind).toBe("ok");

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveChallenges(db, second.challengeId, snapshot);

    expect(await challengeStates(raw)).toEqual([
      { id: first.challengeId, state: "consumed" },
      { id: second.challengeId, state: "revoked" },
    ]);

    const retry = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_consumed_pred",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(retry.kind).toBe("ok");

    const competing = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_other_claim",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(competing.kind).toBe("conflict");
  });

  it("does not re-issue a revoked predecessor that already minted a claim", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    await markMailSent(raw, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued" }];

    await raw.run(
      `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at = ? WHERE id = ?`,
      "clm_racy", toTimestamp(NOW_MS + 1), first.challengeId,
    );

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveChallenges(db, second.challengeId, snapshot);

    const predecessor = withMs(await raw.first(
      "SELECT state, claim_id, consumed_at FROM auth_challenges WHERE id = ?",
      first.challengeId,
    )) as { state: string; claim_id: string | null; consumed_at_ms: number | null };
    expect(predecessor).toEqual({
      state: "revoked",
      claim_id: "clm_racy",
      consumed_at_ms: null,
    });
    expect(await challengeStates(raw)).toEqual([
      { id: first.challengeId, state: "revoked" },
      { id: second.challengeId, state: "revoked" },
    ]);

    const competing = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_new_claimant",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(competing.kind).toBe("invalid");
  });

  it("does not restore an older unused link after a delivered sibling was revoked", async () => {
    const { raw, db } = await seeded();
    const older = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(older.kind).toBe("issued");
    if (older.kind !== "issued") return;
    await markMailSent(raw, older.challengeId, NOW_MS);
    const listedFirst = [{ id: older.challengeId, state: "issued" }];

    const sibling = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(sibling.kind).toBe("issued");
    if (sibling.kind !== "issued") return;
    await markMailSent(raw, sibling.challengeId, NOW_MS + 1);

    const late = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(late.kind).toBe("issued");
    if (late.kind !== "issued") return;

    await restoreLiveChallenges(db, late.challengeId, listedFirst);

    expect(await challengeStates(raw)).toEqual([
      { id: older.challengeId, state: "revoked" },
      { id: sibling.challengeId, state: "issued" },
      { id: late.challengeId, state: "revoked" },
    ]);

    const siblingRedeem = await redeemLoginChallenge(db, {
      credential: sibling.credential,
      redemptionId: "clm_sibling_keep",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(siblingRedeem.kind).toBe("ok");

    const olderRedeem = await redeemLoginChallenge(db, {
      credential: older.credential,
      redemptionId: "clm_older_intercepted",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(olderRedeem.kind).toBe("invalid");
  });

  it("does not restore predecessors when the new challenge is no longer unused issued", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    await markMailSent(raw, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued" }];

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    const redeemedNew = await redeemLoginChallenge(db, {
      credential: second.credential,
      redemptionId: "clm_new_consumed",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "test",
    });
    expect(redeemedNew.kind).toBe("ok");

    await restoreLiveChallenges(db, second.challengeId, snapshot);

    expect(await challengeStates(raw)).toEqual([
      { id: first.challengeId, state: "revoked" },
      { id: second.challengeId, state: "consumed" },
    ]);
  });

  it("does not restore an undelivered sibling after two overlapping failed sends", async () => {
    const { raw, db } = await seeded();
    const delivered = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(delivered.kind).toBe("issued");
    if (delivered.kind !== "issued") return;
    await markMailSent(raw, delivered.challengeId, NOW_MS);
    const snapshotA = [{ id: delivered.challengeId, state: "issued" }];

    const a = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(a.kind).toBe("issued");
    if (a.kind !== "issued") return;
    const snapshotB = [{ id: a.challengeId, state: "issued" }];

    const b = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(b.kind).toBe("issued");
    if (b.kind !== "issued") return;

    await restoreLiveChallenges(db, a.challengeId, snapshotA);
    await restoreLiveChallenges(db, b.challengeId, snapshotB);

    expect(await challengeStates(raw)).toEqual([
      { id: delivered.challengeId, state: "issued" },
      { id: a.challengeId, state: "revoked" },
      { id: b.challengeId, state: "revoked" },
    ]);

    const deliveredRedeem = await redeemLoginChallenge(db, {
      credential: delivered.credential,
      redemptionId: "clm_delivered_keep",
      nowMs: NOW_MS + 3,
      authRoot,
      userAgentLabel: "test",
    });
    expect(deliveredRedeem.kind).toBe("ok");

    const undeliveredRedeem = await redeemLoginChallenge(db, {
      credential: a.credential,
      redemptionId: "clm_undelivered_a",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(undeliveredRedeem.kind).toBe("invalid");
  });

  // claim_id alone marks B as the newest used successor, whether or not
  // mail_sent_at_ms ever stuck on it.
  it.each([["mailed", true], ["unmailed", false]])(
    "does not restore mailed A after %s claimed B and failed C",
    async (_label, bMailed) => {
    const { raw, db } = await seeded();
    const a = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(a.kind).toBe("issued");
    if (a.kind !== "issued") return;
    await markMailSent(raw, a.challengeId, NOW_MS);

    const b = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(b.kind).toBe("issued");
    if (b.kind !== "issued") return;
    if (bMailed) await markMailSent(raw, b.challengeId, NOW_MS + 1);
    await raw.run(
      `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at = ? WHERE id = ?`,
      "clm_b", toTimestamp(NOW_MS + 2), b.challengeId,
    );
    const snapshotC = [{ id: b.challengeId, state: "claimed" }];

    const c = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 3,
      authRoot,
    });
    expect(c.kind).toBe("issued");
    if (c.kind !== "issued") return;

    await restoreLiveChallenges(db, c.challengeId, snapshotC);

    expect(await challengeStates(raw)).toEqual([
      { id: a.challengeId, state: "revoked" },
      { id: b.challengeId, state: "revoked" },
      { id: c.challengeId, state: "revoked" },
    ]);
    const leftover = withMs(await raw.first(
      "SELECT state, claim_id FROM auth_challenges WHERE id = ?",
      b.challengeId,
    )) as { state: string; claim_id: string | null };
    expect(leftover).toEqual({ state: "revoked", claim_id: "clm_b" });

    const aRedeem = await redeemLoginChallenge(db, {
      credential: a.credential,
      redemptionId: "clm_restore_a",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(aRedeem.kind).toBe("invalid");
    },
  );

  it("restores a concurrent first send that the snapshot missed", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    await markMailSent(raw, first.challengeId, NOW_MS);

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveChallenges(db, second.challengeId, []);

    expect(await challengeStates(raw)).toEqual([
      { id: first.challengeId, state: "issued" },
      { id: second.challengeId, state: "revoked" },
    ]);

    const firstRedeem = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_concurrent_keep",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "test",
    });
    expect(firstRedeem.kind).toBe("ok");
  });

  it("restores an issued predecessor whose mail_sent_at write was swallowed", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    const snapshot = [{ id: first.challengeId, state: "issued" }];

    const marked = withMs(await raw.first(
      "SELECT mail_sent_at FROM auth_challenges WHERE id = ?",
      first.challengeId,
    )) as { mail_sent_at_ms: number | null };
    expect(marked.mail_sent_at_ms).toBeNull();

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveChallenges(db, second.challengeId, snapshot);

    expect(await challengeStates(raw)).toEqual([
      { id: first.challengeId, state: "issued" },
      { id: second.challengeId, state: "revoked" },
    ]);

    const firstRedeem = await redeemLoginChallenge(db, {
      credential: first.credential,
      redemptionId: "clm_swallowed_marker",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "test",
    });
    expect(firstRedeem.kind).toBe("ok");
  });
});

describe("restoreLiveChallenges email_change", () => {
  const FOUNDER_ID = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!;

  it("restores a prior address when a later different-address challenge is rolled back", async () => {
    const { raw, db } = await seeded();
    const login = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(login.kind).toBe("issued");
    if (login.kind !== "issued") return;
    const session = await redeemLoginChallenge(db, {
      credential: login.credential,
      redemptionId: "clm_email_restore_login",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(session.kind).toBe("ok");
    if (session.kind !== "ok" || !session.sessionId) return;

    const toA = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-a@example.com",
      emailDisplay: "address-a@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(toA.kind).toBe("issued");
    if (toA.kind !== "issued") return;
    await markMailSent(raw, toA.challengeId, NOW_MS + 2);
    const snapshot = [{ id: toA.challengeId, state: "issued" }];

    const toB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 3,
      authRoot,
    });
    expect(toB.kind).toBe("issued");
    if (toB.kind !== "issued") return;

    await restoreLiveChallenges(db, toB.challengeId, snapshot);

    const rows = withMs(await raw.all(
      "SELECT email_canonical, state FROM auth_challenges WHERE purpose = ? ORDER BY issued_at",
      EMAIL_CHANGE_PURPOSE,
    )) as { email_canonical: string; state: string }[];
    expect(rows).toEqual([
      { email_canonical: "address-a@example.com", state: "issued" },
      { email_canonical: "address-b@example.com", state: "revoked" },
    ]);
  });

  it("restores every unused snapshot row, not the newest marked row in the union", async () => {
    const { raw, db } = await seeded();
    const login = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(login.kind).toBe("issued");
    if (login.kind !== "issued") return;
    const session = await redeemLoginChallenge(db, {
      credential: login.credential,
      redemptionId: "clm_email_restore_two_user_login",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(session.kind).toBe("ok");
    if (session.kind !== "ok" || !session.sessionId) return;

    const toA = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-a@example.com",
      emailDisplay: "address-a@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(toA.kind).toBe("issued");
    if (toA.kind !== "issued") return;
    await markMailSent(raw, toA.challengeId, NOW_MS + 2);

    const otherId = await ensureUserWithDefaults(db, {
      emailCanonical: "other@example.com",
      emailDisplay: "other@example.com",
      nowMs: NOW_MS + 3,
      newUuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const otherSession = await issueSessionForClaim(db, {
      userId: otherId,
      claimId: "clm_other_restore_session",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "other",
    });
    expect(otherSession.kind).toBe("ok");
    if (otherSession.kind !== "ok") return;
    const otherB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: otherId,
      sessionId: otherSession.sessionId,
      nowMs: NOW_MS + 5,
      authRoot,
    });
    expect(otherB.kind).toBe("issued");
    if (otherB.kind !== "issued") return;
    await markMailSent(raw, otherB.challengeId, NOW_MS + 5);

    const snapshot = [
      { id: toA.challengeId, state: "issued" },
      { id: otherB.challengeId, state: "issued" },
    ];
    const callerB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 6,
      authRoot,
    });
    expect(callerB.kind).toBe("issued");
    if (callerB.kind !== "issued") return;

    await restoreLiveChallenges(db, callerB.challengeId, snapshot);

    const rows = withMs(await raw.all(
      `SELECT email_canonical, user_id, state FROM auth_challenges
         WHERE purpose = ? ORDER BY issued_at`,
      EMAIL_CHANGE_PURPOSE,
    )) as { email_canonical: string; user_id: string; state: string }[];
    expect(rows).toEqual([
      { email_canonical: "address-a@example.com", user_id: FOUNDER_ID, state: "issued" },
      { email_canonical: "address-b@example.com", user_id: otherId, state: "issued" },
      { email_canonical: "address-b@example.com", user_id: FOUNDER_ID, state: "revoked" },
    ]);
  });

  it("keeps restoring later snapshot ids when one restore unique-conflicts", async () => {
    const { raw, db } = await seeded();
    const login = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(login.kind).toBe("issued");
    if (login.kind !== "issued") return;
    const session = await redeemLoginChallenge(db, {
      credential: login.credential,
      redemptionId: "clm_email_restore_unique_login",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "test",
    });
    expect(session.kind).toBe("ok");
    if (session.kind !== "ok" || !session.sessionId) return;

    const toA = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-a@example.com",
      emailDisplay: "address-a@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(toA.kind).toBe("issued");
    if (toA.kind !== "issued") return;

    const otherId = await ensureUserWithDefaults(db, {
      emailCanonical: "other@example.com",
      emailDisplay: "other@example.com",
      nowMs: NOW_MS + 3,
      newUuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const otherSession = await issueSessionForClaim(db, {
      userId: otherId,
      claimId: "clm_unique_other_session",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "other",
    });
    expect(otherSession.kind).toBe("ok");
    if (otherSession.kind !== "ok") return;
    const otherB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: otherId,
      sessionId: otherSession.sessionId,
      nowMs: NOW_MS + 5,
      authRoot,
    });
    expect(otherB.kind).toBe("issued");
    if (otherB.kind !== "issued") return;

    const snapshot = [
      { id: otherB.challengeId, state: "issued" },
      { id: toA.challengeId, state: "issued" },
    ];
    const callerB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: FOUNDER_ID,
      sessionId: session.sessionId,
      nowMs: NOW_MS + 6,
      authRoot,
    });
    expect(callerB.kind).toBe("issued");
    if (callerB.kind !== "issued") return;

    const thirdId = await ensureUserWithDefaults(db, {
      emailCanonical: "third@example.com",
      emailDisplay: "third@example.com",
      nowMs: NOW_MS + 7,
      newUuid: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    const thirdSession = await issueSessionForClaim(db, {
      userId: thirdId,
      claimId: "clm_unique_third_session",
      nowMs: NOW_MS + 8,
      authRoot,
      userAgentLabel: "third",
    });
    expect(thirdSession.kind).toBe("ok");
    if (thirdSession.kind !== "ok") return;
    const thirdB = await issueEmailChangeChallenge(db, {
      emailCanonical: "address-b@example.com",
      emailDisplay: "address-b@example.com",
      userId: thirdId,
      sessionId: thirdSession.sessionId,
      nowMs: NOW_MS + 9,
      authRoot,
    });
    expect(thirdB.kind).toBe("issued");
    if (thirdB.kind !== "issued") return;

    await restoreLiveChallenges(db, callerB.challengeId, snapshot);

    const rows = withMs(await raw.all(
      `SELECT email_canonical, user_id, state FROM auth_challenges
         WHERE purpose = ? ORDER BY issued_at`,
      EMAIL_CHANGE_PURPOSE,
    )) as { email_canonical: string; user_id: string; state: string }[];
    expect(rows).toEqual([
      { email_canonical: "address-a@example.com", user_id: FOUNDER_ID, state: "issued" },
      { email_canonical: "address-b@example.com", user_id: otherId, state: "revoked" },
      { email_canonical: "address-b@example.com", user_id: FOUNDER_ID, state: "revoked" },
      { email_canonical: "address-b@example.com", user_id: thirdId, state: "issued" },
    ]);
  });
});
