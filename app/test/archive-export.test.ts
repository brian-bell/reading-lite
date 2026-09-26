import { describe, expect, it } from "vitest";
import {
  exportDownloadHref,
  exportInProgress,
  exportLimitSentence,
  exportRequestFromResponse,
  latestExportFromResponse,
  nextRequestAtMs,
  type ArchiveExport,
  type ExportsResult,
} from "../src/archive-export";

// GET /api/exports/latest as the backend answers it
// (GetArchiveExportLatestResponseSchema).
const summary = (over: Partial<ArchiveExport> = {}): ArchiveExport => ({
  id: "exp_1",
  status: "ready",
  requested_at: "2026-09-25T09:00:00.000Z",
  started_at: "2026-09-25T09:00:05.000Z",
  completed_at: "2026-09-25T09:02:00.000Z",
  expires_at: "2026-10-02T09:02:00.000Z",
  error: null,
  ...over,
});
const latest = (exported: ArchiveExport | null, next = "2026-09-26T09:00:00.000Z") => ({
  export: exported,
  next_allowed_at: next,
});

describe("latestExportFromResponse", () => {
  it.each([
    ["the latest export", latest(summary())],
    ["no export yet", latest(null)],
    ["a failed export with its code", latest(summary({ status: "failed", expires_at: null, error: { code: "zip_limit" } }))],
  ])("returns %s on 200", (_case, body) => {
    expect(latestExportFromResponse(200, body)).toEqual({ state: "ready", value: body });
  });

  it("maps 403 and 412 to their states rather than a throw", () => {
    expect(latestExportFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(latestExportFromResponse(412, { error: "expected tenant mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [503, { error: "control plane unavailable" }, "control plane unavailable"],
    [502, null, "export status returned 502"],
    [200, latest(summary({ status: "zipping" as ArchiveExport["status"] })), "export status returned an unexpected body"],
    [200, { export: null }, "export status returned an unexpected body"],
  ])("throws status %i with its message", (status, body, message) => {
    expect(() => latestExportFromResponse(status, body)).toThrow(expect.objectContaining({ status, message }));
  });
});

describe("exportRequestFromResponse", () => {
  it.each([
    [202, { id: "exp_2", status: "queued" }, { kind: "queued", id: "exp_2" }],
    [409, { error: "export_active", id: "exp_1" }, { kind: "active" }],
    [429, { limit: "daily_export", reset_at: "2026-09-26T09:00:00.000Z" }, { kind: "limited", resetAt: "2026-09-26T09:00:00.000Z" }],
    [429, { limit: "daily_export", reset_at: 7 }, { kind: "limited", resetAt: undefined }],
    [503, { error: "export queue unavailable" }, { kind: "unavailable" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j to an outcome", (status, body, outcome) => {
    expect(exportRequestFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [429, { error: "too many requests" }, "too many requests"],
    [500, null, "failed to request an export"],
    [202, { status: "queued" }, "export request returned an unexpected body"],
  ])("throws %i", (status, body, message) => {
    expect(() => exportRequestFromResponse(status, body)).toThrow(expect.objectContaining({ status, message }));
  });
});

describe("exportInProgress", () => {
  const read = (exported: ArchiveExport | null): ExportsResult => ({ state: "ready", value: latest(exported) });

  it.each([
    ["queued", true],
    ["building", true],
    ["ready", false],
    ["failed", false],
    ["expired", false],
    ["cancelled", false],
  ] as const)("is %s → %s", (status, polls) => {
    expect(exportInProgress(read(summary({ status })))).toBe(polls);
  });

  it.each([
    ["no export yet", read(null)],
    ["a refused read", { state: "forbidden" } as const],
    ["no read yet", undefined],
  ])("is false for %s", (_case, result) => {
    expect(exportInProgress(result)).toBe(false);
  });
});

describe("nextRequestAtMs", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");

  it.each([
    ["a time still ahead", "2026-09-26T09:00:00.000Z", Date.parse("2026-09-26T09:00:00.000Z")],
    ["now", "2026-09-25T12:00:00.000Z", undefined],
    ["a time already past", "2026-09-24T09:00:00.000Z", undefined],
    ["an unreadable time", "soon", undefined],
  ])("reads %s", (_case, next, expected) => {
    expect(nextRequestAtMs(latest(null, next), now)).toBe(expected);
  });
});

describe("exportLimitSentence", () => {
  it("names the daily limit and when the next request is allowed", () => {
    expect(exportLimitSentence("2026-09-26T09:00:00.000Z")).toBe(
      "You've reached the daily export limit. You can request another at 26 September 2026, 09:00 UTC.",
    );
  });

  it("names the limit alone when the reset is missing or unreadable", () => {
    expect(exportLimitSentence(undefined)).toBe("You've reached the daily export limit.");
    expect(exportLimitSentence("soon")).toBe("You've reached the daily export limit.");
  });
});

describe("exportDownloadHref", () => {
  it("is the same-origin download route for that export", () => {
    expect(exportDownloadHref("exp_1")).toBe("/api/exports/exp_1/download");
    expect(exportDownloadHref("exp/../x")).toBe("/api/exports/exp%2F..%2Fx/download");
  });
});
