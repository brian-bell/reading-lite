import { describe, expect, it } from "vitest";
import {
  digestEnvelopeV1,
  parseDigestEnvelope,
} from "../../../src/control-plane/digest-envelope";
import { parseTenantId, parseUserId } from "../../../src/control-plane/ids";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    tenantId: TENANT,
    userId: TENANT,
    period_key: "2026-09-02",
    cadence: "daily",
    ...overrides,
  };
}

describe("parseDigestEnvelope", () => {
  it("accepts a v1 identity+ledger envelope and strips extras", () => {
    const parsed = parseDigestEnvelope({
      ...valid(),
      email: "secret@example.com",
      readingIds: ["rd_1"],
    });
    expect(parsed).toEqual({
      ok: true,
      envelope: {
        version: 1,
        tenantId: TENANT,
        userId: TENANT,
        period_key: "2026-09-02",
        cadence: "daily",
      },
    });
    if (parsed.ok) {
      expect(parsed.envelope).not.toHaveProperty("email");
      expect(parsed.envelope).not.toHaveProperty("readingIds");
    }
  });

  it("rejects unknown version, absent tenant, mismatched ids, and bad period_key", () => {
    expect(parseDigestEnvelope({ id: "rd_1" })).toEqual({ ok: false, reason: "unknown_version" });
    expect(parseDigestEnvelope(valid({ tenantId: "" }))).toEqual({
      ok: false,
      reason: "absent_tenant",
    });
    expect(parseDigestEnvelope(valid({ userId: "usr_11111111-1111-4111-8111-111111111111" }))).toEqual(
      { ok: false, reason: "malformed_id" },
    );
    expect(parseDigestEnvelope(valid({ period_key: "2026-W36" }))).toEqual({
      ok: false,
      reason: "malformed_job",
    });
    expect(parseDigestEnvelope(valid({ cadence: "weekly", period_key: "2026-09-02" }))).toEqual({
      ok: false,
      reason: "malformed_job",
    });
  });

  it("round-trips what the cron enqueues through the parser", () => {
    const envelope = digestEnvelopeV1({
      tenantId: parseTenantId(TENANT)!,
      userId: parseUserId(TENANT)!,
      period_key: "2026-W36",
      cadence: "weekly",
    });
    expect(parseDigestEnvelope(envelope)).toEqual({ ok: true, envelope });
  });
});
