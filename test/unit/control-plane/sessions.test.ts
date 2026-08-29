import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TTL_MS,
  SESSION_LAST_SEEN_COALESCE_MS,
} from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { redeemLoginChallenge } from "../../../src/control-plane/redeem";
import { authenticateSession } from "../../../src/control-plane/sessions";
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
  if (redeemed.kind !== "ok") throw new Error("expected session");
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
