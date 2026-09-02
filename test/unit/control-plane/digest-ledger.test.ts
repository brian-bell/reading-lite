import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret } from "../../../src/control-plane/crypto";
import {
  claimPendingDigestDelivery,
  deletePendingDigestDelivery,
  finalizeDigestDelivery,
  getDigestDelivery,
  touchPendingDigestDelivery,
} from "../../../src/control-plane/digest-ledger";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-02T09:00:00.000Z");
const USER_ID = "usr_550e8400-e29b-41d4-a716-446655440000";
const KEY = { userId: USER_ID, cadence: "daily" as const, periodKey: "2026-09-02" };

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

describe("digest_deliveries ledger CAS", () => {
  it("inserts pending once per (user, cadence, period_key) then treats the row as terminal after send", async () => {
    const { db } = await bootstrapped();
    expect(await claimPendingDigestDelivery(db, KEY, NOW_MS)).toBe("inserted");
    expect(await claimPendingDigestDelivery(db, KEY, NOW_MS + 1)).toBe("pending");
    expect(await finalizeDigestDelivery(db, KEY, { status: "sent", resendId: "re_1" }, NOW_MS + 2)).toBe(
      "sent",
    );
    expect(await claimPendingDigestDelivery(db, KEY, NOW_MS + 3)).toBe("terminal");
    expect(await getDigestDelivery(db, KEY)).toMatchObject({
      status: "sent",
      period_key: "2026-09-02",
      cadence: "daily",
      resend_id: "re_1",
    });
  });

  it("keeps a skipped row skipped on a later send attempt", async () => {
    const { db } = await bootstrapped();
    await claimPendingDigestDelivery(db, KEY, NOW_MS);
    expect(
      await finalizeDigestDelivery(db, KEY, { status: "skipped", reason: "cadence_off" }, NOW_MS + 1),
    ).toBe("skipped");
    expect(await finalizeDigestDelivery(db, KEY, { status: "sent" }, NOW_MS + 2)).toBe("skipped");
    expect(await getDigestDelivery(db, KEY)).toMatchObject({
      status: "skipped",
      skip_reason: "cadence_off",
    });
  });

  it("deletes only a pending row so the period can be claimed again", async () => {
    const { db } = await bootstrapped();
    await claimPendingDigestDelivery(db, KEY, NOW_MS);
    expect(await deletePendingDigestDelivery(db, KEY)).toBe(true);
    expect(await getDigestDelivery(db, KEY)).toBeNull();
    expect(await claimPendingDigestDelivery(db, KEY, NOW_MS + 1)).toBe("inserted");

    await finalizeDigestDelivery(db, KEY, { status: "sent" }, NOW_MS + 2);
    expect(await deletePendingDigestDelivery(db, KEY)).toBe(false);
    expect(await getDigestDelivery(db, KEY)).toMatchObject({ status: "sent" });
  });

  it("touches only a pending row so a later tick can treat it as fresh", async () => {
    const { db } = await bootstrapped();
    await claimPendingDigestDelivery(db, KEY, NOW_MS);
    expect(await touchPendingDigestDelivery(db, KEY, NOW_MS + 1)).toBe(true);
    expect(await getDigestDelivery(db, KEY)).toMatchObject({
      status: "pending",
      updated_at_ms: NOW_MS + 1,
      created_at_ms: NOW_MS,
    });
    await finalizeDigestDelivery(db, KEY, { status: "sent" }, NOW_MS + 2);
    expect(await touchPendingDigestDelivery(db, KEY, NOW_MS + 3)).toBe(false);
  });
});
