import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { reprocessFromResponse, type ReprocessOutcome } from "../src/reprocess";

// What a reprocess answered (#410). The 429 and 503 bodies are parsed by
// capture-refusal.ts and owned by the save tests; here only that a reprocess
// hands them over.

describe("reprocessFromResponse", () => {
  it.each<{ name: string; status: number; body: unknown; outcome: ReprocessOutcome }>([
    {
      name: "a 202 as started",
      status: 202,
      body: { id: "rd_1", status: "pending", poll: "/api/readings/rd_1", attempt_id: "att_1" },
      outcome: { kind: "started" },
    },
    { name: "a 200 as started", status: 200, body: { id: "rd_1", status: "ready" }, outcome: { kind: "started" } },
    {
      name: "a 409 active attempt as already processing",
      status: 409,
      body: { error: "reading already has an active attempt" },
      outcome: { kind: "already-processing" },
    },
    {
      name: "a 409 missing Markdown as its own refusal",
      status: 409,
      body: { error: "markdown content not available" },
      outcome: { kind: "markdown-missing" },
    },
    {
      name: "a 409 for a missing provider key as the key-required refusal",
      status: 409,
      body: { error: "connect a key, then retry", code: "provider_key_required" },
      outcome: { kind: "key-required" },
    },
    {
      name: "a 400 in the backend's words",
      status: 400,
      body: { error: "url rejected: host is not allowed", code: "unsupported_url" },
      outcome: { kind: "invalid", message: "url rejected: host is not allowed" },
    },
    {
      name: "a 400 that says nothing in its own words",
      status: 400,
      body: null,
      outcome: { kind: "invalid", message: "This reading can't be processed again." },
    },
    { name: "a 403 as forbidden", status: 403, body: { error: "forbidden" }, outcome: { kind: "forbidden" } },
    { name: "a 404 as not found", status: 404, body: { error: "not found" }, outcome: { kind: "not-found" } },
    {
      name: "a 412 with the account it names",
      status: 412,
      body: { error: "expected tenant mismatch", acting_tenant: "usr_b" },
      outcome: { kind: "account-changed", actingTenant: "usr_b" },
    },
    {
      name: "a 429 as the shared limit refusal",
      status: 429,
      body: { error: "hourly reading quota exceeded", code: "quota_exhausted", limit: "hourly", reset_at: "2026-09-16T18:00:00Z" },
      outcome: { kind: "limited", limit: "hourly", resetAt: "2026-09-16T18:00:00Z" },
    },
    { name: "a 503 as the shared unavailable refusal", status: 503, body: { error: "queue unbound" }, outcome: { kind: "unavailable" } },
  ])("reads $name", ({ status, body, outcome }) => {
    expect(reprocessFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    { name: "a 401", status: 401, body: { error: "unauthorized" } },
    { name: "a 409 it has no words for", status: 409, body: { error: "something else" } },
    { name: "a 500", status: 500, body: null },
  ])("throws an ApiError with the status for $name", ({ status, body }) => {
    expect(() => reprocessFromResponse(status, body)).toThrow(expect.objectContaining({ status }) as ApiError);
  });
});
