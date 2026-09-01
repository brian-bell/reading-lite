import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueEmailChangeChallenge, issueLoginChallenge } from "../../../src/control-plane/challenges";
import { EMAIL_CHANGE_PURPOSE } from "../../../src/control-plane/constants";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import type { ControlPlaneDb } from "../../../src/control-plane/db";
import { parseSessionId, parseUserId } from "../../../src/control-plane/ids";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };

async function seeded(signupMode: "open" | "invite_only" = "invite_only") {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode,
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => "usr_550e8400-e29b-41d4-a716-446655440000",
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db };
}

describe("issueLoginChallenge", () => {
  it("issues a newest-only login challenge for an existing user and delivers to email_display", async () => {
    const { sqlite, db } = await seeded();
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
    const rows = sqlite.prepare("SELECT state FROM auth_challenges ORDER BY issued_at_ms").all() as {
      state: string;
    }[];
    expect(rows.map((row) => row.state)).toEqual(["revoked", "issued"]);
  });

  it("skips unknown addresses unless an unconsumed invite exists", async () => {
    const { sqlite, db } = await seeded("invite_only");
    const skipped = await issueLoginChallenge(db, {
      emailCanonical: "new@example.com",
      emailDisplayRequested: "New@example.com",
      nowMs: NOW_MS,
      authRoot,
    });
    expect(skipped).toEqual({ kind: "skipped" });

    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run("new@example.com", "New@example.com", NOW_MS, NOW_MS + 86_400_000);

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

  it("serializes overlapping issues so only one issued challenge exists", async () => {
    const { sqlite, db } = await seeded();
    const racing = twoWriterRaceDb(db);
    const [first, second] = await Promise.all([
      issueLoginChallenge(racing, {
        emailCanonical: "founder@example.com",
        emailDisplayRequested: "founder@example.com",
        nowMs: NOW_MS,
        authRoot,
      }),
      issueLoginChallenge(racing, {
        emailCanonical: "founder@example.com",
        emailDisplayRequested: "founder@example.com",
        nowMs: NOW_MS + 1,
        authRoot,
      }),
    ]);
    expect(first.kind).toBe("issued");
    expect(second.kind).toBe("issued");
    const issued = sqlite
      .prepare("SELECT COUNT(*) AS n FROM auth_challenges WHERE state = 'issued'")
      .get() as { n: number };
    expect(issued.n).toBe(1);
  });
});

const FOUNDER_ID = parseUserId("usr_550e8400-e29b-41d4-a716-446655440000")!;
const DUMMY_SESSION_ID = parseSessionId("ses_550e8400-e29b-41d4-a716-446655440000")!;

describe("issueEmailChangeChallenge", () => {
  it("binds the challenge to the caller and delivers to the requested new address", async () => {
    const { sqlite, db } = await seeded();
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
    const row = sqlite
      .prepare(
        "SELECT purpose, user_id, email_canonical, email_display, bound_session_id FROM auth_challenges WHERE id = ?",
      )
      .get(issued.challengeId) as {
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
    const { sqlite, db } = await seeded();
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
    const rows = sqlite
      .prepare("SELECT email_canonical, state FROM auth_challenges WHERE purpose = ? ORDER BY issued_at_ms")
      .all(EMAIL_CHANGE_PURPOSE) as { email_canonical: string; state: string }[];
    expect(rows).toEqual([
      { email_canonical: "a@example.com", state: "revoked" },
      { email_canonical: "b@example.com", state: "issued" },
    ]);
  });
});

function twoWriterRaceDb(inner: ControlPlaneDb): ControlPlaneDb {
  let started = 0;
  let releaseFirst: (() => void) | undefined;
  let firstWaiting: Promise<void> | undefined;

  return {
    first: (sql, ...params) => inner.first(sql, ...params),
    all: (sql, ...params) => inner.all(sql, ...params),
    run: (sql, ...params) => inner.run(sql, ...params),
    async batch(statements) {
      const [head, ...rest] = statements;
      if (!head) return [];
      const results = [await inner.run(head.sql, ...head.params)];
      started += 1;
      if (started === 1) {
        firstWaiting = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await firstWaiting;
      } else if (started === 2) {
        releaseFirst?.();
      }
      for (const statement of rest) {
        results.push(await inner.run(statement.sql, ...statement.params));
      }
      return results;
    },
  };
}
