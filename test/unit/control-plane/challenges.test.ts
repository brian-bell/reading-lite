import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { issueLoginChallenge } from "../../../src/control-plane/challenges";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
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
});
