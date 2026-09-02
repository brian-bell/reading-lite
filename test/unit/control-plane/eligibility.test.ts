import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import { resolveLoginEligibility, loadSignupMode } from "../../../src/control-plane/eligibility";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const authRoot = { secret: parseAuthRootSecret(ROOT_HEX), version: 1 };
const FOUNDER = "usr_550e8400-e29b-41d4-a716-446655440000";
const SUSPENDED = "usr_660e8400-e29b-41d4-a716-446655440000";

async function seeded(signupMode: "open" | "invite_only" | "closed") {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode,
    nowMs: NOW_MS,
    authRoot,
    newUserId: () => FOUNDER,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  sqlite
    .prepare(
      `INSERT INTO users (
         id, email_canonical, email_display, status,
         created_at_ms, updated_at_ms, suspended_at_ms
       ) VALUES (?, 'suspended@example.com', 'Suspended@example.com', 'suspended', ?, ?, ?)`,
    )
    .run(SUSPENDED, NOW_MS, NOW_MS, NOW_MS);
  return { sqlite, db };
}

describe("resolveLoginEligibility matrix", () => {
  it.each([
    ["closed", "existing", { kind: "existing_user" }],
    ["closed", "unknown", { kind: "ineligible" }],
    ["closed", "suspended", { kind: "ineligible" }],
    ["invite_only", "existing", { kind: "existing_user" }],
    ["invite_only", "unknown", { kind: "ineligible" }],
    ["invite_only", "suspended", { kind: "ineligible" }],
    ["open", "existing", { kind: "existing_user" }],
    ["open", "unknown", { kind: "provisionable", source: "open" }],
    ["open", "suspended", { kind: "ineligible" }],
  ] as const)("%s × %s", async (mode, who, expected) => {
    const { db } = await seeded(mode);
    const email =
      who === "existing" ? "founder@example.com" : who === "suspended" ? "suspended@example.com" : "new@example.com";
    const result = await resolveLoginEligibility(db, email, NOW_MS);
    expect(result.kind).toBe(expected.kind);
    if (expected.kind === "provisionable" && result.kind === "provisionable") {
      expect(result.source).toBe(expected.source);
    }
    if (expected.kind === "existing_user" && result.kind === "existing_user") {
      expect(result.user.email_display).toBe("Founder@Example.com");
      expect(result.user.status).toBe("active");
    }
  });

  it("invite_only unknown with a live invite is provisionable", async () => {
    const { sqlite, db } = await seeded("invite_only");
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms, expires_at_ms)
         VALUES ('invited@example.com', 'Invited@example.com', ?, ?)`,
      )
      .run(NOW_MS, NOW_MS + 86_400_000);
    const result = await resolveLoginEligibility(db, "invited@example.com", NOW_MS);
    expect(result).toEqual({
      kind: "provisionable",
      emailDisplay: "Invited@example.com",
      source: "invite",
    });
  });

  it("closed ignores a live invite for an unknown address", async () => {
    const { sqlite, db } = await seeded("closed");
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
         VALUES ('invited@example.com', 'Invited@example.com', ?)`,
      )
      .run(NOW_MS);
    expect(await resolveLoginEligibility(db, "invited@example.com", NOW_MS)).toEqual({ kind: "ineligible" });
  });

  it("invite_only treats consumed or expired invites as ineligible", async () => {
    const { sqlite, db } = await seeded("invite_only");
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms, consumed_at_ms)
         VALUES ('used@example.com', 'Used@example.com', ?, ?)`,
      )
      .run(NOW_MS, NOW_MS);
    sqlite
      .prepare(
        `INSERT INTO signup_invites (email_canonical, email_display, created_at_ms, expires_at_ms)
         VALUES ('stale@example.com', 'Stale@example.com', ?, ?)`,
      )
      .run(NOW_MS, NOW_MS);
    expect(await resolveLoginEligibility(db, "used@example.com", NOW_MS)).toEqual({ kind: "ineligible" });
    expect(await resolveLoginEligibility(db, "stale@example.com", NOW_MS)).toEqual({ kind: "ineligible" });
  });
});

describe("loadSignupMode", () => {
  it("defaults to closed when system_policy is missing", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    sqlite.prepare("DELETE FROM system_policy").run();
    expect(await loadSignupMode(db)).toBe("closed");
  });
});
