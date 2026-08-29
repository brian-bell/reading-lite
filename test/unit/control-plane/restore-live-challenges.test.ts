import { describe, expect, it } from "vitest";
import { restoreLiveLoginChallenges } from "../../../src/control-plane/auth-handlers";
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

function challengeStates(sqlite: ReturnType<typeof openMigratedControlPlane>["sqlite"]) {
  return sqlite
    .prepare("SELECT id, state FROM auth_challenges ORDER BY issued_at_ms")
    .all() as { id: string; state: string }[];
}

function markMailSent(
  sqlite: ReturnType<typeof openMigratedControlPlane>["sqlite"],
  challengeId: string,
  atMs: number,
): void {
  sqlite.prepare("UPDATE auth_challenges SET mail_sent_at_ms = ? WHERE id = ?").run(atMs, challengeId);
}

describe("restoreLiveLoginChallenges", () => {
  it("does not revive a predecessor that was consumed before issue revoked it", async () => {
    const { sqlite, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    markMailSent(sqlite, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued", issued_at_ms: NOW_MS }];

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

    await restoreLiveLoginChallenges(db, second.challengeId, snapshot);

    expect(challengeStates(sqlite)).toEqual([
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
    const { sqlite, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    markMailSent(sqlite, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued", issued_at_ms: NOW_MS }];

    sqlite
      .prepare(
        `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at_ms = ? WHERE id = ?`,
      )
      .run("clm_racy", NOW_MS + 1, first.challengeId);

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, second.challengeId, snapshot);

    const predecessor = sqlite
      .prepare("SELECT state, claim_id, consumed_at_ms FROM auth_challenges WHERE id = ?")
      .get(first.challengeId) as { state: string; claim_id: string | null; consumed_at_ms: number | null };
    expect(predecessor).toEqual({
      state: "revoked",
      claim_id: "clm_racy",
      consumed_at_ms: null,
    });
    expect(challengeStates(sqlite)).toEqual([
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
    const { sqlite, db } = await seeded();
    const older = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(older.kind).toBe("issued");
    if (older.kind !== "issued") return;
    markMailSent(sqlite, older.challengeId, NOW_MS);
    const listedFirst = [{ id: older.challengeId, state: "issued", issued_at_ms: NOW_MS }];

    const sibling = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(sibling.kind).toBe("issued");
    if (sibling.kind !== "issued") return;
    markMailSent(sqlite, sibling.challengeId, NOW_MS + 1);

    const late = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(late.kind).toBe("issued");
    if (late.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, late.challengeId, listedFirst);

    expect(challengeStates(sqlite)).toEqual([
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
    const { sqlite, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    markMailSent(sqlite, first.challengeId, NOW_MS);
    const snapshot = [{ id: first.challengeId, state: "issued", issued_at_ms: NOW_MS }];

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

    await restoreLiveLoginChallenges(db, second.challengeId, snapshot);

    expect(challengeStates(sqlite)).toEqual([
      { id: first.challengeId, state: "revoked" },
      { id: second.challengeId, state: "consumed" },
    ]);
  });

  it("does not restore an undelivered sibling after two overlapping failed sends", async () => {
    const { sqlite, db } = await seeded();
    const delivered = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(delivered.kind).toBe("issued");
    if (delivered.kind !== "issued") return;
    markMailSent(sqlite, delivered.challengeId, NOW_MS);
    const snapshotA = [{ id: delivered.challengeId, state: "issued", issued_at_ms: NOW_MS }];

    const a = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(a.kind).toBe("issued");
    if (a.kind !== "issued") return;
    const snapshotB = [{ id: a.challengeId, state: "issued", issued_at_ms: NOW_MS + 1 }];

    const b = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 2,
      authRoot,
    });
    expect(b.kind).toBe("issued");
    if (b.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, a.challengeId, snapshotA);
    await restoreLiveLoginChallenges(db, b.challengeId, snapshotB);

    expect(challengeStates(sqlite)).toEqual([
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

  it("does not restore mailed A after mailed+claimed B and failed C", async () => {
    const { sqlite, db } = await seeded();
    const a = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(a.kind).toBe("issued");
    if (a.kind !== "issued") return;
    markMailSent(sqlite, a.challengeId, NOW_MS);

    const b = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(b.kind).toBe("issued");
    if (b.kind !== "issued") return;
    markMailSent(sqlite, b.challengeId, NOW_MS + 1);
    sqlite
      .prepare(
        `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at_ms = ? WHERE id = ?`,
      )
      .run("clm_b", NOW_MS + 2, b.challengeId);
    const snapshotC = [{ id: b.challengeId, state: "claimed", issued_at_ms: NOW_MS + 1 }];

    const c = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 3,
      authRoot,
    });
    expect(c.kind).toBe("issued");
    if (c.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, c.challengeId, snapshotC);

    expect(challengeStates(sqlite)).toEqual([
      { id: a.challengeId, state: "revoked" },
      { id: b.challengeId, state: "revoked" },
      { id: c.challengeId, state: "revoked" },
    ]);
    const leftover = sqlite
      .prepare("SELECT state, claim_id FROM auth_challenges WHERE id = ?")
      .get(b.challengeId) as { state: string; claim_id: string | null };
    expect(leftover).toEqual({ state: "revoked", claim_id: "clm_b" });

    const aRedeem = await redeemLoginChallenge(db, {
      credential: a.credential,
      redemptionId: "clm_restore_a",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(aRedeem.kind).toBe("invalid");
  });

  it("does not restore an older mailed leftover after a claimed successor with no mail_sent_at", async () => {
    const { sqlite, db } = await seeded();
    const older = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(older.kind).toBe("issued");
    if (older.kind !== "issued") return;
    markMailSent(sqlite, older.challengeId, NOW_MS);

    const claimed = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(claimed.kind).toBe("issued");
    if (claimed.kind !== "issued") return;
    sqlite
      .prepare(
        `UPDATE auth_challenges SET state = 'claimed', claim_id = ?, claimed_at_ms = ? WHERE id = ?`,
      )
      .run("clm_unmarked_claimed", NOW_MS + 2, claimed.challengeId);
    const marker = sqlite
      .prepare("SELECT mail_sent_at_ms FROM auth_challenges WHERE id = ?")
      .get(claimed.challengeId) as { mail_sent_at_ms: number | null };
    expect(marker.mail_sent_at_ms).toBeNull();
    const snapshot = [{ id: claimed.challengeId, state: "claimed", issued_at_ms: NOW_MS + 1 }];

    const failed = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 3,
      authRoot,
    });
    expect(failed.kind).toBe("issued");
    if (failed.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, failed.challengeId, snapshot);

    expect(challengeStates(sqlite)).toEqual([
      { id: older.challengeId, state: "revoked" },
      { id: claimed.challengeId, state: "revoked" },
      { id: failed.challengeId, state: "revoked" },
    ]);
    const leftover = sqlite
      .prepare("SELECT state, claim_id FROM auth_challenges WHERE id = ?")
      .get(claimed.challengeId) as { state: string; claim_id: string | null };
    expect(leftover).toEqual({ state: "revoked", claim_id: "clm_unmarked_claimed" });

    const olderRedeem = await redeemLoginChallenge(db, {
      credential: older.credential,
      redemptionId: "clm_older_blocked_by_claimed",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(olderRedeem.kind).toBe("invalid");
  });

  it("does not restore an older mailed leftover after an unlisted consumed successor with no mail_sent_at", async () => {
    const { sqlite, db } = await seeded();
    const older = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(older.kind).toBe("issued");
    if (older.kind !== "issued") return;
    markMailSent(sqlite, older.challengeId, NOW_MS);

    const successor = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(successor.kind).toBe("issued");
    if (successor.kind !== "issued") return;
    const consumed = await redeemLoginChallenge(db, {
      credential: successor.credential,
      redemptionId: "clm_unlisted_consumed",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "test",
    });
    expect(consumed.kind).toBe("ok");
    const marker = sqlite
      .prepare("SELECT mail_sent_at_ms, claim_id, consumed_at_ms FROM auth_challenges WHERE id = ?")
      .get(successor.challengeId) as {
      mail_sent_at_ms: number | null;
      claim_id: string | null;
      consumed_at_ms: number | null;
    };
    expect(marker.mail_sent_at_ms).toBeNull();
    expect(marker.claim_id).toBe("clm_unlisted_consumed");
    expect(marker.consumed_at_ms).not.toBeNull();

    const failed = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 3,
      authRoot,
    });
    expect(failed.kind).toBe("issued");
    if (failed.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, failed.challengeId, []);

    expect(challengeStates(sqlite)).toEqual([
      { id: older.challengeId, state: "revoked" },
      { id: successor.challengeId, state: "consumed" },
      { id: failed.challengeId, state: "revoked" },
    ]);

    const olderRedeem = await redeemLoginChallenge(db, {
      credential: older.credential,
      redemptionId: "clm_older_blocked_by_consumed",
      nowMs: NOW_MS + 4,
      authRoot,
      userAgentLabel: "test",
    });
    expect(olderRedeem.kind).toBe("invalid");
  });

  it("restores a concurrent first send that the snapshot missed", async () => {
    const { sqlite, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    markMailSent(sqlite, first.challengeId, NOW_MS);

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, second.challengeId, []);

    expect(challengeStates(sqlite)).toEqual([
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
    const { sqlite, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    const snapshot = [{ id: first.challengeId, state: "issued", issued_at_ms: NOW_MS }];

    const marked = sqlite
      .prepare("SELECT mail_sent_at_ms FROM auth_challenges WHERE id = ?")
      .get(first.challengeId) as { mail_sent_at_ms: number | null };
    expect(marked.mail_sent_at_ms).toBeNull();

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    if (second.kind !== "issued") return;

    await restoreLiveLoginChallenges(db, second.challengeId, snapshot);

    expect(challengeStates(sqlite)).toEqual([
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
