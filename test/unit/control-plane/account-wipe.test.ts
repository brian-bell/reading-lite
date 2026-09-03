import { describe, expect, it } from "vitest";
import {
  ACCOUNT_WIPE_GRACE_MS,
  ACCOUNT_WIPE_IN_FLIGHT_MS,
  ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS,
  isAccountWipeDlq,
  isAccountWipeQueue,
  readingIdFromRelativeKey,
  wipeGraceElapsed,
  wipeLeaseHeld,
  wipeNeedsResume,
  wipeRetryDelaySeconds,
} from "../../../src/account-wipe";
import {
  parseAccountWipeEnvelope,
  accountWipeEnvelopeV1,
} from "../../../src/control-plane/wipe-envelope";
import { parseTenantId } from "../../../src/control-plane/ids";

const TENANT = parseTenantId("usr_550e8400-e29b-41d4-a716-446655440000")!;
const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");

describe("wipeGraceElapsed", () => {
  it("requires deleting_at_ms and a full 7-day window", () => {
    expect(wipeGraceElapsed(null, NOW_MS)).toBe(false);
    expect(wipeGraceElapsed(undefined, NOW_MS)).toBe(false);
    expect(wipeGraceElapsed(NOW_MS, NOW_MS)).toBe(false);
    expect(wipeGraceElapsed(NOW_MS - ACCOUNT_WIPE_GRACE_MS + 1, NOW_MS)).toBe(false);
    expect(wipeGraceElapsed(NOW_MS - ACCOUNT_WIPE_GRACE_MS, NOW_MS)).toBe(true);
    expect(wipeGraceElapsed(NOW_MS - ACCOUNT_WIPE_GRACE_MS - 1, NOW_MS)).toBe(true);
  });
});

describe("wipeNeedsResume", () => {
  it("treats missing progress as a new wipe and incomplete/leftover as resume", () => {
    expect(wipeNeedsResume(null, false)).toBe(false);
    expect(wipeNeedsResume(null, true)).toBe(false);
    expect(wipeNeedsResume({ phase: "done" }, false)).toBe(false);
    expect(wipeNeedsResume({ phase: "done" }, true)).toBe(true);
    expect(wipeNeedsResume({ phase: "vectors" }, false)).toBe(true);
    expect(wipeNeedsResume({ phase: "objects" }, false)).toBe(true);
  });
});

describe("wipeLeaseHeld", () => {
  it("holds through a future retry lease and expires after the in-flight window", () => {
    expect(wipeLeaseHeld(NOW_MS, NOW_MS)).toBe(true);
    expect(wipeLeaseHeld(NOW_MS, NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS - 1)).toBe(true);
    expect(wipeLeaseHeld(NOW_MS, NOW_MS + ACCOUNT_WIPE_IN_FLIGHT_MS)).toBe(false);
    expect(wipeLeaseHeld(NOW_MS + ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS * 1000, NOW_MS)).toBe(true);
    expect(
      wipeLeaseHeld(
        NOW_MS + ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS * 1000,
        NOW_MS + ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS * 1000 + ACCOUNT_WIPE_IN_FLIGHT_MS - 1,
      ),
    ).toBe(true);
    expect(
      wipeLeaseHeld(
        NOW_MS + ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS * 1000,
        NOW_MS + ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS * 1000 + ACCOUNT_WIPE_IN_FLIGHT_MS,
      ),
    ).toBe(false);
  });
});

describe("parseAccountWipeEnvelope", () => {
  it("parses v1 identity and defaults force to false", () => {
    expect(parseAccountWipeEnvelope({ version: 1, tenantId: TENANT })).toEqual({
      ok: true,
      envelope: { version: 1, tenantId: TENANT, force: false },
    });
    expect(parseAccountWipeEnvelope(accountWipeEnvelopeV1({ tenantId: TENANT, force: true }))).toEqual({
      ok: true,
      envelope: { version: 1, tenantId: TENANT, force: true },
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseAccountWipeEnvelope(null)).toEqual({ ok: false, reason: "unknown_version" });
    expect(parseAccountWipeEnvelope({ version: 2, tenantId: TENANT })).toEqual({
      ok: false,
      reason: "unknown_version",
    });
    expect(parseAccountWipeEnvelope({ version: 1 })).toEqual({ ok: false, reason: "absent_tenant" });
    expect(parseAccountWipeEnvelope({ version: 1, tenantId: "founder" })).toEqual({
      ok: false,
      reason: "malformed_id",
    });
  });
});

describe("readingIdFromRelativeKey", () => {
  it("extracts ids from by-id pointers and reading object keys", () => {
    expect(readingIdFromRelativeKey("index/by-id/rd_0123456780")).toBe("rd_0123456780");
    expect(readingIdFromRelativeKey("readings/2026/04/26T200000Z-rd_0123456780/manifest.json")).toBe(
      "rd_0123456780",
    );
    expect(readingIdFromRelativeKey("index/list.json")).toBeNull();
    expect(readingIdFromRelativeKey("index/by-url/deadbeef")).toBeNull();
  });
});

describe("wipeRetryDelaySeconds", () => {
  it("uses Retry-After when present and exponential otherwise", () => {
    expect(wipeRetryDelaySeconds(12_500, 1)).toBe(13);
    expect(wipeRetryDelaySeconds(null, 1)).toBe(30);
    expect(wipeRetryDelaySeconds(null, 2)).toBe(60);
    expect(wipeRetryDelaySeconds(null, 5)).toBe(300);
    expect(wipeRetryDelaySeconds(24 * 60 * 60 * 1000, 1)).toBe(ACCOUNT_WIPE_RETRY_MAX_DELAY_SECONDS);
  });
});

describe("wipe queue names", () => {
  it("recognizes the shared wipe queues only", () => {
    expect(isAccountWipeQueue("reading-lite-wipe")).toBe(true);
    expect(isAccountWipeQueue("reading-lite-staging-wipe")).toBe(true);
    expect(isAccountWipeQueue("reading-lite")).toBe(false);
    expect(isAccountWipeDlq("reading-lite-wipe-dlq")).toBe(true);
    expect(isAccountWipeDlq("reading-lite-staging-wipe-dlq")).toBe(true);
    expect(isAccountWipeDlq("reading-lite-dlq")).toBe(false);
  });
});
