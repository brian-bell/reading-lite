// Lock-then-act under real parallelism (ADR 0005, slice 1c.2). D1 had a single
// writer, so the control plane never raced itself; on PostgreSQL each of these
// calls runs on its own connection (testControlPlane opens one per call and
// per transaction), and only the locks keep the outcome what D1 gave.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issueEmailChangeChallenge, issueLoginChallenge } from "../../src/control-plane/challenges";
import { parseAuthRootSecret } from "../../src/control-plane/crypto";
import { parseSessionId, parseUserId } from "../../src/control-plane/ids";
import { redeemLoginChallenge } from "../../src/control-plane/redeem";
import { ensureUserWithDefaults, issueSessionForClaim } from "../../src/control-plane/sessions";
import { testControlPlane } from "../helpers/control-plane-db";
import { FOUNDER_TENANT_ID } from "../helpers/tenant-fixtures";

const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const PARALLEL = 8;
const authRoot = () => ({ secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET), version: 1 });
const db = () => testControlPlane(env);

async function challengeStates(purpose: string, email: string): Promise<string[]> {
  const rows = await db().all<{ state: string }>(
    "SELECT state FROM auth_challenges WHERE purpose = ? AND email_canonical = ? ORDER BY issue_seq",
    purpose,
    email,
  );
  return rows.map((row) => row.state);
}

describe("newest-only challenge issue under parallel requests", () => {
  it("leaves exactly one issued login challenge, the last one committed", async () => {
    const issued = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        issueLoginChallenge(db(), {
          emailCanonical: "founder@test.example",
          emailDisplayRequested: "founder@test.example",
          nowMs: NOW_MS + i,
          authRoot: authRoot(),
        }),
      ),
    );

    expect(issued.every((result) => result.kind === "issued")).toBe(true);
    const states = await challengeStates("login", "founder@test.example");
    expect(states).toHaveLength(PARALLEL);
    expect(states.filter((state) => state === "issued")).toHaveLength(1);
    // Newest-only: the survivor is the last issue to commit.
    expect(states.at(-1)).toBe("issued");
  });

  it("leaves one issued email-change challenge per user even across different target addresses", async () => {
    const userId = parseUserId(FOUNDER_TENANT_ID)!;
    const sessionId = parseSessionId("ses_550e8400-e29b-41d4-a716-446655440000")!;
    await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        issueEmailChangeChallenge(db(), {
          emailCanonical: `target-${i}@test.example`,
          emailDisplay: `target-${i}@test.example`,
          userId,
          sessionId,
          nowMs: NOW_MS + i,
          authRoot: authRoot(),
        }),
      ),
    );

    const live = await db().all<{ email_canonical: string }>(
      "SELECT email_canonical FROM auth_challenges WHERE purpose = 'email_change' AND user_id = ? AND state = 'issued'",
      userId,
    );
    expect(live).toHaveLength(1);
  });
});

describe("idempotent claim retry under parallel redeems", () => {
  it("resolves every retry of one claim to the same session, minted once", async () => {
    const issued = await issueLoginChallenge(db(), {
      emailCanonical: "founder@test.example",
      emailDisplayRequested: "founder@test.example",
      nowMs: NOW_MS,
      authRoot: authRoot(),
    });
    if (issued.kind !== "issued") throw new Error("expected a challenge");

    const redeemed = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        redeemLoginChallenge(db(), {
          credential: issued.credential,
          redemptionId: "clm_parallel_retry",
          nowMs: NOW_MS + 1,
          authRoot: authRoot(),
          userAgentLabel: "test",
        }),
      ),
    );

    const sessionIds = new Set(redeemed.map((result) => (result.kind === "ok" ? result.sessionId : result.kind)));
    expect(sessionIds.size).toBe(1);
    expect([...sessionIds][0]).toMatch(/^ses_/);
    const sessions = await db().all(
      "SELECT id FROM sessions WHERE created_from_claim_id = ?",
      "clm_parallel_retry",
    );
    expect(sessions).toHaveLength(1);
    expect(await challengeStates("login", "founder@test.example")).toEqual(["consumed"]);
  });

  it("gives a different claim on the same link a conflict, not a second session", async () => {
    const issued = await issueLoginChallenge(db(), {
      emailCanonical: "founder@test.example",
      emailDisplayRequested: "founder@test.example",
      nowMs: NOW_MS,
      authRoot: authRoot(),
    });
    if (issued.kind !== "issued") throw new Error("expected a challenge");

    const redeemed = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        redeemLoginChallenge(db(), {
          credential: issued.credential,
          redemptionId: `clm_parallel_${i}`,
          nowMs: NOW_MS + 1,
          authRoot: authRoot(),
          userAgentLabel: "test",
        }),
      ),
    );

    expect(redeemed.filter((result) => result.kind === "ok")).toHaveLength(1);
    expect(redeemed.filter((result) => result.kind === "conflict")).toHaveLength(PARALLEL - 1);
    const sessions = await db().all("SELECT id FROM sessions WHERE created_from_claim_id LIKE 'clm_parallel_%'");
    expect(sessions).toHaveLength(1);
  });
});

describe("email change under parallel redeems", () => {
  it("lets only one of two users take one address, and burns the loser's link", async () => {
    const founder = parseUserId(FOUNDER_TENANT_ID)!;
    const other = await ensureUserWithDefaults(db(), {
      emailCanonical: "other@test.example",
      emailDisplay: "other@test.example",
      nowMs: NOW_MS,
    });
    const sessionFor = async (userId: typeof founder, claimId: string) => {
      const issued = await issueSessionForClaim(db(), { userId, claimId, nowMs: NOW_MS, authRoot: authRoot(), userAgentLabel: null });
      if (issued.kind !== "ok") throw new Error("expected a session");
      return issued.sessionId;
    };
    const change = async (userId: typeof founder, sessionId: string, email: string) => {
      const issued = await issueEmailChangeChallenge(db(), {
        emailCanonical: email,
        emailDisplay: email,
        userId,
        sessionId: parseSessionId(sessionId)!,
        nowMs: NOW_MS,
        authRoot: authRoot(),
      });
      if (issued.kind !== "issued") throw new Error("expected a challenge");
      return issued;
    };
    const founderSession = await sessionFor(founder, "clm_founder_live");
    const otherSession = await sessionFor(other, "clm_other_live");
    const a = await change(founder, founderSession, "race-a@test.example");
    const b = await change(other, otherSession, "race-b@test.example");
    // Both claimed, both aimed at one address: two changes that crossed.
    await db().run(
      `UPDATE auth_challenges
          SET email_canonical = 'race@test.example', email_display = 'race@test.example', state = 'claimed',
              claim_id = CASE WHEN id = ? THEN 'clm_race_a' ELSE 'clm_race_b' END
        WHERE id IN (?, ?)`,
      a.challengeId,
      a.challengeId,
      b.challengeId,
    );

    const [first, second] = await Promise.all([
      redeemLoginChallenge(db(), {
        credential: a.credential,
        redemptionId: "clm_race_a",
        nowMs: NOW_MS + 1,
        authRoot: authRoot(),
        userAgentLabel: null,
        sessionCookiePresent: true,
        stepUpSessionId: founderSession,
      }),
      redeemLoginChallenge(db(), {
        credential: b.credential,
        redemptionId: "clm_race_b",
        nowMs: NOW_MS + 1,
        authRoot: authRoot(),
        userAgentLabel: null,
        sessionCookiePresent: true,
        stepUpSessionId: otherSession,
      }),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["conflict", "ok"]);
    expect(await db().all("SELECT id FROM users WHERE email_canonical = 'race@test.example'")).toHaveLength(1);
    const loser = first.kind === "conflict" ? a : b;
    expect(await db().first("SELECT state FROM auth_challenges WHERE id = ?", loser.challengeId)).toEqual({
      state: "revoked",
    });
  });
});
