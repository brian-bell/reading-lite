import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import {
  itemRequestsImmediateEmail,
  resolveDigestRecipient,
  resolveImmediateNotification,
} from "../../../src/control-plane/reading-notification";
import { getUserSettings, updateUserSettings } from "../../../src/control-plane/user-settings";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER_ID = "usr_550e8400-e29b-41d4-a716-446655440000";

async function bootstrapped() {
  const { sqlite, db } = openMigratedControlPlane();
  await bootstrapFounder(db, {
    email: "Founder@Example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER_ID,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { sqlite, db };
}

const sendEnv = {
  APP_ENV: "test",
  EMAIL_FROM: "reading-lite@test.example",
  FOUNDER_EMAIL: "Founder@Example.com",
};

describe("itemRequestsImmediateEmail", () => {
  it("always skips import, even when email is true", () => {
    expect(itemRequestsImmediateEmail({ trigger: "import", email: true })).toBe(false);
    expect(itemRequestsImmediateEmail({ trigger: "import", email: false })).toBe(false);
    expect(itemRequestsImmediateEmail({ trigger: "import" })).toBe(false);
  });

  it("honors email:false and keeps submit default true", () => {
    expect(itemRequestsImmediateEmail({ trigger: "submit", email: false })).toBe(false);
    expect(itemRequestsImmediateEmail({ trigger: "submit" })).toBe(true);
    expect(itemRequestsImmediateEmail({ trigger: "submit", email: true })).toBe(true);
  });

  it("defaults reprocess to silent unless email is true", () => {
    expect(itemRequestsImmediateEmail({ trigger: "reprocess" })).toBe(false);
    expect(itemRequestsImmediateEmail({ trigger: "reprocess", email: true })).toBe(true);
    expect(itemRequestsImmediateEmail({ trigger: "reprocess", email: false })).toBe(false);
  });
});

describe("getUserSettings / updateUserSettings", () => {
  it("returns the full row and updates only notify_immediate when digest keys are omitted", async () => {
    const { db } = await bootstrapped();
    const before = await getUserSettings(db, USER_ID);
    expect(before).toMatchObject({
      user_id: USER_ID,
      schema_version: 1,
      notify_immediate: true,
      digest_cadence: "off",
      time_zone: "UTC",
      digest_hour_local: 9,
      digest_weekday: 1,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
    });

    const later = NOW_MS + 1_000;
    const after = await updateUserSettings(db, {
      userId: USER_ID,
      notifyImmediate: false,
      nowMs: later,
    });
    expect(after).toMatchObject({
      notify_immediate: false,
      digest_cadence: "off",
      time_zone: "UTC",
      digest_hour_local: 9,
      digest_weekday: 1,
      created_at_ms: NOW_MS,
      updated_at_ms: later,
    });
  });

  it("persists digest fields including when cadence is off", async () => {
    const { db } = await bootstrapped();
    const later = NOW_MS + 2_000;
    const weekly = await updateUserSettings(db, {
      userId: USER_ID,
      notifyImmediate: true,
      digestCadence: "weekly",
      timeZone: "America/New_York",
      digestHourLocal: 8,
      digestWeekday: 5,
      nowMs: later,
    });
    expect(weekly).toMatchObject({
      notify_immediate: true,
      digest_cadence: "weekly",
      time_zone: "America/New_York",
      digest_hour_local: 8,
      digest_weekday: 5,
      updated_at_ms: later,
    });

    const off = await updateUserSettings(db, {
      userId: USER_ID,
      notifyImmediate: false,
      digestCadence: "off",
      timeZone: "Europe/London",
      digestHourLocal: 0,
      digestWeekday: 7,
      nowMs: later + 1_000,
    });
    expect(off).toMatchObject({
      notify_immediate: false,
      digest_cadence: "off",
      time_zone: "Europe/London",
      digest_hour_local: 0,
      digest_weekday: 7,
    });
  });

  it("returns null when the settings row is missing", async () => {
    const { sqlite, db } = await bootstrapped();
    sqlite.prepare("DELETE FROM user_settings WHERE user_id = ?").run(USER_ID);
    expect(await getUserSettings(db, USER_ID)).toBeNull();
    expect(
      await updateUserSettings(db, { userId: USER_ID, notifyImmediate: true, nowMs: NOW_MS }),
    ).toBeNull();
  });
});

describe("resolveImmediateNotification", () => {
  it("sends to current email_display and never EMAIL_TO", async () => {
    const { db } = await bootstrapped();
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "send",
      to: "Founder@Example.com",
      from: "reading-lite@test.example",
    });
  });

  it("skips empty FROM, opt-out, missing settings, inactive, unverified, and allowlist", async () => {
    const { sqlite, db } = await bootstrapped();

    await expect(
      resolveImmediateNotification(db, { ...sendEnv, EMAIL_FROM: "   " }, USER_ID),
    ).resolves.toEqual({ kind: "skip", reason: "empty_from" });

    sqlite.prepare("UPDATE user_settings SET notify_immediate = 0 WHERE user_id = ?").run(USER_ID);
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "opted_out",
    });

    sqlite.prepare("DELETE FROM user_settings WHERE user_id = ?").run(USER_ID);
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "missing_settings",
    });

    sqlite
      .prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
      .run(USER_ID);
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "inactive_user",
    });

    sqlite.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").run(USER_ID);
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "inactive_user",
    });

    sqlite
      .prepare("UPDATE users SET status = 'active', email_verified_at_ms = NULL WHERE id = ?")
      .run(USER_ID);
    await expect(resolveImmediateNotification(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "unverified_email",
    });

    await expect(
      resolveImmediateNotification(db, sendEnv, "usr_11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual({ kind: "skip", reason: "missing_user" });
  });

  it("applies staging AUTH_MAIL_ALLOWLIST", async () => {
    const { db } = await bootstrapped();
    await expect(
      resolveImmediateNotification(
        db,
        {
          APP_ENV: "staging",
          AUTH_MAIL_ALLOWLIST: "",
          FOUNDER_EMAIL: "other@example.com",
          EMAIL_FROM: "reading-lite@test.example",
        },
        USER_ID,
      ),
    ).resolves.toEqual({ kind: "skip", reason: "allowlist" });

    await expect(
      resolveImmediateNotification(
        db,
        {
          APP_ENV: "staging",
          AUTH_MAIL_ALLOWLIST: "",
          FOUNDER_EMAIL: "Founder@Example.com",
          EMAIL_FROM: "reading-lite@test.example",
        },
        USER_ID,
      ),
    ).resolves.toEqual({
      kind: "send",
      to: "Founder@Example.com",
      from: "reading-lite@test.example",
    });
  });
});

describe("resolveDigestRecipient", () => {
  it("sends to email_display even when notify_immediate is off", async () => {
    const { sqlite, db } = await bootstrapped();
    sqlite.prepare("UPDATE user_settings SET notify_immediate = 0 WHERE user_id = ?").run(USER_ID);
    await expect(resolveDigestRecipient(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "send",
      to: "Founder@Example.com",
      from: "reading-lite@test.example",
    });
  });

  it("skips empty FROM, inactive, unverified, missing user, and allowlist — not notify_immediate", async () => {
    const { sqlite, db } = await bootstrapped();
    await expect(resolveDigestRecipient(db, { ...sendEnv, EMAIL_FROM: "  " }, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "empty_from",
    });

    sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(USER_ID);
    await expect(resolveDigestRecipient(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "inactive_user",
    });

    sqlite.prepare("UPDATE users SET status = 'deleting' WHERE id = ?").run(USER_ID);
    await expect(resolveDigestRecipient(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "inactive_user",
    });

    sqlite
      .prepare("UPDATE users SET status = 'active', email_verified_at_ms = NULL WHERE id = ?")
      .run(USER_ID);
    await expect(resolveDigestRecipient(db, sendEnv, USER_ID)).resolves.toEqual({
      kind: "skip",
      reason: "unverified_email",
    });

    await expect(
      resolveDigestRecipient(db, sendEnv, "usr_11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual({ kind: "skip", reason: "missing_user" });
  });
});
