import { describe, expect, it } from "vitest";
import { settingsFromResponse, settingsSaveFromResponse } from "../src/settings";

// The settings row as GET/POST /api/auth/settings return it
// (UserSettingsResponseSchema), including the fields this app does not read.
const row = {
  user_id: "usr_a",
  schema_version: 1,
  notify_immediate: true,
  digest_cadence: "weekly",
  time_zone: "America/New_York",
  digest_hour_local: 8,
  digest_weekday: 1,
  created_at_ms: 1,
  updated_at_ms: 2,
};

const read = (status: number, body: unknown) => {
  const result = settingsFromResponse(status, body);
  if (result.state === "ready") return { kind: "saved" as const, settings: result.value };
  if (result.state === "forbidden") return { kind: "forbidden" as const };
  return { kind: "account-changed" as const, actingTenant: result.acting_tenant };
};

describe.each([
  ["settingsFromResponse", read],
  ["settingsSaveFromResponse", settingsSaveFromResponse],
])("%s", (_name, parse) => {
  it("parses the stored row on 200, keeping fields it does not read", () => {
    expect(parse(200, row)).toEqual({ kind: "saved", settings: row });
  });

  it("maps 403 and 412 to their states rather than a throw", () => {
    expect(parse(403, { error: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(parse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
  });

  it.each([
    ["a missing field", { ...row, notify_immediate: undefined }],
    ["an unknown cadence", { ...row, digest_cadence: "hourly" }],
    ["a fractional hour", { ...row, digest_hour_local: 8.5 }],
    ["no JSON at all", null],
  ])("throws the retryable unexpected-body error for %s", (_case, body) => {
    expect(() => parse(200, body)).toThrow(/unexpected body/);
  });

  it("throws a 401 and a 5xx with the backend's message", () => {
    expect(() => parse(401, { error: "unauthorized" })).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => parse(503, { error: "control plane unavailable" })).toThrow(
      expect.objectContaining({ status: 503, message: "control plane unavailable" }),
    );
  });
});
