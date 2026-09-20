import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueEmailChangeChallenge, issueLoginChallenge } from "../../../src/control-plane/challenges";
import { EMAIL_CHANGE_PURPOSE } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { parseSessionId, parseUserId } from "../../../src/control-plane/ids";
import { useControlPlane, withMs } from "../../helpers/control-plane-pg";
import { toTimestamp } from "../../../src/control-plane/pg-time";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seeded(signupMode: "open" | "invite_only" = "invite_only") {
  const { raw, db } = openControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode,
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { raw, db };
}

describe("issueLoginChallenge", () => {
  it("issues a newest-only login challenge for an existing user and delivers to email_display", async () => {
    const { raw, db } = await seeded();
    const first = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "FOUNDER@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") return;
    expect(first.deliveryEmail).toBe("Founder@Example.com");
    expect(first.credential.startsWith("ml_")).toBe(true);

    const second = await issueLoginChallenge(db, {
      emailCanonical: "founder@example.com",
      emailDisplayRequested: "founder@example.com",
      nowMs: NOW_MS + 1,
      authRoot,
    });
    expect(second.kind).toBe("issued");
    const rows = withMs(await raw.all("SELECT state FROM auth_challenges ORDER BY issued_at")) as {
      state: string;
    }[];
    expect(rows.map((row) => row.state)).toEqual(["revoked", "issued"]);
  });

  it("skips unknown addresses unless an unconsumed invite exists", async () => {
    const { raw, db } = await seeded("invite_only");
    const skipped = await issueLoginChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplayRequested: "New@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(skipped).toEqual({ kind: "skipped" });

    await raw.run(
      `INSERT INTO signup_invites (email_canonical, email_display, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      "new@example.com", "New@example.com", toTimestamp(NOW_MS), toTimestamp(NOW_MS + 86_400_000),
    );

    const issued = await issueLoginChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplayRequested: "new@EXAMPLE.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;
    expect(issued.deliveryEmail).toBe("New@example.com");
  });

});

const FOUNDER_ID = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!;
const DUMMY_SESSION_ID = parseSessionId("ses_550e8400-e29b-41d4-a716-446655440000")!;

describe("issueEmailChangeChallenge", () => {
  it("binds the challenge to the caller and delivers to the requested new address", async () => {
    const { raw, db } = await seeded();
    const issued = await issueEmailChangeChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplay: "New@example.com",
      userId: FOUNDER_ID,
      sessionId: DUMMY_SESSION_ID,
      nowMs: NOW_MS,
      authRoot,
    });
    expect(issued.kind).toBe("issued");
    if (issued.kind !== "issued") return;
    expect(issued.deliveryEmail).toBe("New@example.com");
    const row = withMs(await raw.first(
      "SELECT purpose, user_id, email_canonical, email_display, bound_session_id FROM auth_challenges WHERE id = ?",
      issued.challengeId,
    )) as {
      purpose: string;
      user_id: string;
      email_canonical: string;
      email_display: string;
      bound_session_id: string | null;
    };
    expect(row).toEqual({
      purpose: EMAIL_CHANGE_PURPOSE,
      user_id: FOUNDER_ID,
      email_canonical: "new@example.com",
      email_display: "New@example.com",
      bound_session_id: DUMMY_SESSION_ID,
    });
  });

  it("revokes a prior email-change challenge for the same user even when the target differs", async () => {
    const { raw, db } = await seeded();
    await issueEmailChangeChallenge(db, {
      emailCanonical: "a@example.com",
      emailDisplay: "a@example.com",
      userId: FOUNDER_ID,
      sessionId: DUMMY_SESSION_ID,
      nowMs: NOW_MS,
      authRoot,
    });
    await issueEmailChangeChallenge(db, {
      emailCanonical: "b@example.com",
      emailDisplay: "b@example.com",
      userId: FOUNDER_ID,
      sessionId: DUMMY_SESSION_ID,
      nowMs: NOW_MS + 1,
      authRoot,
    });
    const rows = withMs(await raw.all(
      "SELECT email_canonical, state FROM auth_challenges WHERE purpose = ? ORDER BY issued_at",
      EMAIL_CHANGE_PURPOSE,
    )) as { email_canonical: string; state: string }[];
    expect(rows).toEqual([
      { email_canonical: "a@example.com", state: "revoked" },
      { email_canonical: "b@example.com", state: "issued" },
    ]);
  });
});

