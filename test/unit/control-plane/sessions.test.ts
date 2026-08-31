import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_CAP_WARNING,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TTL_MS,
  SESSION_LAST_SEEN_COALESCE_MS,
} from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import {
  authenticateSession,
  ensureUserWithDefaults,
  issueSessionForClaim,
  listSessionsForUser,
  refreshSessionAuthenticatedAt,
  revokeAllSessionsForUser,
  revokeOwnedSession,
  revokeSession,
} from "../../../src/control-plane/sessions";
import { parseUserId } from "../../../src/control-plane/ids";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function issuedSession() {
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
  const issued = await issueLoginChallenge(db, {
    emailCanonical: "founder@example.com",
    emailDisplayRequested: "founder@example.com",
    nowMs: NOW_MS,
    authRoot,
  });
  if (issued.kind !== "issued") throw new Error("expected challenge");
  const redeemed = await redeemLoginChallenge(db, {
    credential: issued.credential,
    redemptionId: "clm_session-1",
    nowMs: NOW_MS,
    authRoot,
    userAgentLabel: "test",
  });
  if (redeemed.kind !== "ok" || !redeemed.sessionId || !redeemed.credential) throw new Error("expected session");
  return {
    sqlite,
    db,
    cookieHeader: `${SESSION_COOKIE_NAME}=${redeemed.credential}`,
    sessionId: redeemed.sessionId,
  };
}

describe("authenticateSession", () => {
  it("coalesces last-seen writes to at most once per hour and extends idle expiry", async () => {
    const { sqlite, db, cookieHeader, sessionId } = await issuedSession();
    const before = sqlite
      .prepare("SELECT last_seen_at_ms, idle_expires_at_ms FROM sessions WHERE id = ?")
      .get(sessionId) as { last_seen_at_ms: number; idle_expires_at_ms: number };
    expect(before.last_seen_at_ms).toBe(NOW_MS);
    expect(before.idle_expires_at_ms).toBe(NOW_MS + SESSION_IDLE_TTL_MS);

    const withinHour = await authenticateSession(db, {
      cookieHeader,
      authRoot,
      nowMs: NOW_MS + SESSION_LAST_SEEN_COALESCE_MS - 1,
    });
    expect(withinHour.kind).toBe("ok");
    const unchanged = sqlite
      .prepare("SELECT last_seen_at_ms, idle_expires_at_ms FROM sessions WHERE id = ?")
      .get(sessionId) as { last_seen_at_ms: number; idle_expires_at_ms: number };
    expect(unchanged.last_seen_at_ms).toBe(NOW_MS);
    expect(unchanged.idle_expires_at_ms).toBe(NOW_MS + SESSION_IDLE_TTL_MS);

    const laterMs = NOW_MS + SESSION_LAST_SEEN_COALESCE_MS;
    const afterHour = await authenticateSession(db, {
      cookieHeader,
      authRoot,
      nowMs: laterMs,
    });
    expect(afterHour.kind).toBe("ok");
    const touched = sqlite
      .prepare("SELECT last_seen_at_ms, idle_expires_at_ms, absolute_expires_at_ms FROM sessions WHERE id = ?")
      .get(sessionId) as {
      last_seen_at_ms: number;
      idle_expires_at_ms: number;
      absolute_expires_at_ms: number;
    };
    expect(touched.last_seen_at_ms).toBe(laterMs);
    expect(touched.idle_expires_at_ms).toBe(laterMs + SESSION_IDLE_TTL_MS);
    expect(touched.absolute_expires_at_ms).toBe(NOW_MS + SESSION_ABSOLUTE_TTL_MS);
  });

  it("rejects a session after 30 days idle even when the cookie Max-Age remains", async () => {
    const { db, cookieHeader } = await issuedSession();
    const idle = await authenticateSession(db, {
      cookieHeader,
      authRoot,
      nowMs: NOW_MS + SESSION_IDLE_TTL_MS,
    });
    expect(idle.kind).toBe("unauthenticated");
  });

  it("rejects a session after 90-day absolute expiry", async () => {
    const { sqlite, db, cookieHeader, sessionId } = await issuedSession();
    sqlite
      .prepare("UPDATE sessions SET idle_expires_at_ms = ? WHERE id = ?")
      .run(NOW_MS + SESSION_ABSOLUTE_TTL_MS + 1, sessionId);
    const absolute = await authenticateSession(db, {
      cookieHeader,
      authRoot,
      nowMs: NOW_MS + SESSION_ABSOLUTE_TTL_MS,
    });
    expect(absolute.kind).toBe("unauthenticated");
  });
});

describe("issueSessionForClaim", () => {
  it("does not hand out another user's session for a reused claim id", async () => {
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
    const userA = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000");
    if (!userA) throw new Error("expected founder id");

    const sessionA = await issueSessionForClaim(db, {
      userId: userA,
      claimId: "clm_shared-1",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "a",
    });
    expect(sessionA.kind).toBe("ok");
    if (sessionA.kind !== "ok") return;
    const hmacA = sqlite
      .prepare("SELECT secret_hmac FROM sessions WHERE id = ?")
      .get(sessionA.sessionId) as { secret_hmac: string };

    const userB = await ensureUserWithDefaults(db, {
      emailCanonical: "other@example.com",
      emailDisplay: "other@example.com",
      nowMs: NOW_MS,
    });
    const sessionB = await issueSessionForClaim(db, {
      userId: userB,
      claimId: "clm_shared-1",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "b",
    });
    expect(sessionB.kind).toBe("ok");
    if (sessionB.kind !== "ok") return;

    expect(sessionB.sessionId).not.toBe(sessionA.sessionId);
    expect(sessionB.credential).not.toBe(sessionA.credential);
    const hmacAAfter = sqlite
      .prepare("SELECT secret_hmac, user_id FROM sessions WHERE id = ?")
      .get(sessionA.sessionId) as { secret_hmac: string; user_id: string };
    expect(hmacAAfter.secret_hmac).toBe(hmacA.secret_hmac);
    expect(hmacAAfter.user_id).toBe(userA);

    const stillA = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${sessionA.credential}`,
      authRoot,
      nowMs: NOW_MS,
    });
    expect(stillA.kind).toBe("ok");
    if (stillA.kind !== "ok") return;
    expect(stillA.principal.userId).toBe(userA);

    const asB = await authenticateSession(db, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${sessionB.credential}`,
      authRoot,
      nowMs: NOW_MS,
    });
    expect(asB.kind).toBe("ok");
    if (asB.kind !== "ok") return;
    expect(asB.principal.userId).toBe(userB);
  });

  it("treats a revoked claim row as invalid instead of inserting a new session", async () => {
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
    const userA = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000");
    if (!userA) throw new Error("expected founder id");
    const first = await issueSessionForClaim(db, {
      userId: userA,
      claimId: "clm_revoked1",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "a",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    await revokeSession(db, first.sessionId, NOW_MS + 1, "logout");
    const retry = await issueSessionForClaim(db, {
      userId: userA,
      claimId: "clm_revoked1",
      nowMs: NOW_MS + 2,
      authRoot,
      userAgentLabel: "a",
    });
    expect(retry.kind).toBe("invalid");
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("session list, cap warning, and revoke", () => {
  it("marks the current session and warns at the 10-session cap before LRU", async () => {
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
    const userId = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000");
    if (!userId) throw new Error("expected founder id");

    const issued = [];
    for (let i = 0; i < 10; i += 1) {
      const session = await issueSessionForClaim(db, {
        userId,
        claimId: `clm_cap_${i}`,
        nowMs: NOW_MS + i,
        authRoot,
        userAgentLabel: `ua-${i}`,
      });
      expect(session.kind).toBe("ok");
      if (session.kind === "ok") issued.push(session);
    }
    const current = issued[9];
    if (!current) throw new Error("expected tenth session");

    const listed = await listSessionsForUser(db, {
      userId,
      nowMs: NOW_MS + 9,
      currentSessionId: current.sessionId,
    });
    expect(listed.sessions).toHaveLength(10);
    expect(listed.session_cap_warning).toBe(SESSION_CAP_WARNING);
    expect(listed.sessions.filter((row) => row.current)).toHaveLength(1);
    expect(listed.sessions.find((row) => row.current)?.id).toBe(current.sessionId);
    expect(listed.sessions[0]?.user_agent_label).toBe("ua-9");
    expect(listed.sessions.every((row) => row.usable)).toBe(true);

    const eleventh = await issueSessionForClaim(db, {
      userId,
      claimId: "clm_cap_10",
      nowMs: NOW_MS + 10,
      authRoot,
      userAgentLabel: "ua-10",
    });
    expect(eleventh.kind).toBe("ok");
    const after = sqlite
      .prepare(
        "SELECT id, revoked_at_ms, revocation_reason FROM sessions ORDER BY created_at_ms ASC",
      )
      .all() as { id: string; revoked_at_ms: number | null; revocation_reason: string | null }[];
    expect(after).toHaveLength(11);
    expect(after[0]?.revocation_reason).toBe("session_cap");
    expect(after[0]?.revoked_at_ms).toBe(NOW_MS + 10);
    expect(after.filter((row) => row.revoked_at_ms == null)).toHaveLength(10);

    const listedAfter = await listSessionsForUser(db, { userId, nowMs: NOW_MS + 10 });
    expect(listedAfter.session_cap_warning).toBe(SESSION_CAP_WARNING);
    expect(listedAfter.sessions.find((row) => row.revocation_reason === "session_cap")?.usable).toBe(
      false,
    );
    expect(listedAfter.sessions.filter((row) => row.usable)).toHaveLength(10);
  });

  it("keeps idle-expired rows visible as usable false", async () => {
    const { sqlite, db, sessionId } = await issuedSession();
    const userId = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000");
    if (!userId) throw new Error("expected founder id");
    sqlite.prepare("UPDATE sessions SET idle_expires_at_ms = ? WHERE id = ?").run(NOW_MS, sessionId);

    const live = await issueSessionForClaim(db, {
      userId,
      claimId: "clm_expired_live",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "live",
    });
    expect(live.kind).toBe("ok");
    if (live.kind !== "ok") throw new Error("expected live session");

    const listed = await listSessionsForUser(db, {
      userId,
      nowMs: NOW_MS,
      currentSessionId: live.sessionId,
    });
    expect(listed.sessions).toHaveLength(2);
    expect(listed.session_cap_warning).toBeNull();
    expect(listed.sessions.find((row) => row.id === sessionId)).toMatchObject({
      usable: false,
      revoked_at_ms: null,
      current: false,
    });
    expect(listed.sessions.find((row) => row.id === live.sessionId)).toMatchObject({
      usable: true,
      revoked_at_ms: null,
      current: true,
    });
  });

  it("refreshes authenticated_at_ms on the same row", async () => {
    const { sqlite, db, sessionId } = await issuedSession();
    const refreshed = await refreshSessionAuthenticatedAt(db, {
      sessionId,
      userId: parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!,
      nowMs: NOW_MS + 60_000,
    });
    expect(refreshed.kind).toBe("ok");
    const row = sqlite
      .prepare("SELECT authenticated_at_ms FROM sessions WHERE id = ?")
      .get(sessionId) as { authenticated_at_ms: number };
    expect(row.authenticated_at_ms).toBe(NOW_MS + 60_000);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });

  it("revokes one owned session without touching others, and revoke-all clears the rest", async () => {
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
    const userId = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000");
    if (!userId) throw new Error("expected founder id");
    const a = await issueSessionForClaim(db, {
      userId,
      claimId: "clm_a",
      nowMs: NOW_MS,
      authRoot,
      userAgentLabel: "a",
    });
    const b = await issueSessionForClaim(db, {
      userId,
      claimId: "clm_b",
      nowMs: NOW_MS + 1,
      authRoot,
      userAgentLabel: "b",
    });
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind !== "ok" || b.kind !== "ok") return;

    expect(await revokeOwnedSession(db, { sessionId: a.sessionId, userId, nowMs: NOW_MS + 2, reason: "user" })).toBe(
      "ok",
    );
    const afterOne = sqlite.prepare("SELECT id, revoked_at_ms, revocation_reason FROM sessions").all() as {
      id: string;
      revoked_at_ms: number | null;
      revocation_reason: string | null;
    }[];
    expect(afterOne.find((row) => row.id === a.sessionId)?.revocation_reason).toBe("user");
    expect(afterOne.find((row) => row.id === b.sessionId)?.revoked_at_ms).toBeNull();

    expect(await revokeAllSessionsForUser(db, { userId, nowMs: NOW_MS + 3 })).toBe(1);
    const afterAll = sqlite.prepare("SELECT revoked_at_ms, revocation_reason FROM sessions").all() as {
      revoked_at_ms: number | null;
      revocation_reason: string | null;
    }[];
    expect(afterAll.every((row) => row.revoked_at_ms != null)).toBe(true);
    expect(afterAll.map((row) => row.revocation_reason).sort()).toEqual(["revoke_all", "user"]);
  });
});
