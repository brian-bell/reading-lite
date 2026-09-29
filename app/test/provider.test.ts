import { describe, expect, it } from "vitest";
import {
  capFromDollars,
  dollarsOf,
  formatUsd,
  keyConnectFromResponse,
  keyInputError,
  keyRemoveFromResponse,
  keyStateOf,
  preferencesSaveFromResponse,
  providerFromResponse,
  usageFromResponse,
  type ProviderSettings,
} from "../src/provider";

// GET /api/auth/provider and the write responses (ProviderSettingsResponseSchema
// in src/schemas/api.ts), with a field this app does not read.
const settings: ProviderSettings = {
  credential: { provider: "openai", last_four: "c0de", status: "active", validated_at_ms: 1_000 },
  effort: "high",
  daily_spend_cap_microdollars: null,
  effective_daily_spend_microdollars: 2_000_000,
  operator_daily_spend_microdollars: 2_000_000,
};
const row = { ...settings, extra: true };

const usage = {
  day_key: "2026-09-29",
  charged_microdollars: 120_000,
  effective_daily_spend_microdollars: 2_000_000,
  reset_at_ms: 2_000,
  observed_at_ms: 1_500,
};

const RECENT_AUTH = { error: "recent authentication required" };
const MISMATCH = { error: "expected tenant mismatch", acting_tenant: "usr_b" };

describe("providerFromResponse", () => {
  it("parses the settings on 200, keeping fields it does not read", () => {
    expect(providerFromResponse(200, row)).toEqual({ state: "ready", value: row });
    expect(providerFromResponse(200, { ...row, credential: null })).toMatchObject({ value: { credential: null } });
  });

  it("maps 403 and 412 to their states rather than a throw", () => {
    expect(providerFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(providerFromResponse(412, MISMATCH)).toEqual({ state: "account-changed", acting_tenant: "usr_b" });
  });

  it.each([
    ["an unknown effort", { ...row, effort: "max" }],
    ["an unknown credential status", { ...row, credential: { ...settings.credential, status: "revoked" } }],
    ["a missing effective cap", { ...row, effective_daily_spend_microdollars: undefined }],
    ["a fractional cap", { ...row, daily_spend_cap_microdollars: 1.5 }],
    ["no JSON at all", null],
  ])("throws the retryable unexpected-body error for %s", (_case, body) => {
    expect(() => providerFromResponse(200, body)).toThrow(/unexpected body/);
  });

  it("throws a 401 and a 5xx with the backend's message", () => {
    expect(() => providerFromResponse(401, { error: "unauthorized" })).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => providerFromResponse(500, { error: "internal" })).toThrow(
      expect.objectContaining({ status: 500, message: "internal" }),
    );
  });
});

describe("usageFromResponse", () => {
  it("parses today's charges on 200 and maps the refusals", () => {
    expect(usageFromResponse(200, usage)).toEqual({ state: "ready", value: usage });
    expect(usageFromResponse(403, {})).toEqual({ state: "forbidden" });
    expect(usageFromResponse(412, MISMATCH)).toEqual({ state: "account-changed", acting_tenant: "usr_b" });
  });

  it("throws when the guard cannot say, and on a malformed body", () => {
    expect(() => usageFromResponse(503, { error: "usage unavailable" })).toThrow(
      expect.objectContaining({ status: 503, message: "usage unavailable" }),
    );
    expect(() => usageFromResponse(200, { ...usage, charged_microdollars: -1 })).toThrow(/unexpected body/);
  });
});

describe("keyConnectFromResponse", () => {
  it.each([
    [200, row, { kind: "saved", settings: row }],
    [400, { error: "invalid key", code: "invalid_key" }, { kind: "rejected", reason: "invalid_key" }],
    [400, { error: "model access", code: "model_access" }, { kind: "rejected", reason: "model_access" }],
    [400, { error: "invalid body" }, { kind: "invalid" }],
    [503, { error: "provider unavailable", code: "provider_unavailable" }, { kind: "provider-unavailable" }],
    [403, RECENT_AUTH, { kind: "step-up" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, MISMATCH, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j", (status, body, outcome) => {
    expect(keyConnectFromResponse(status, body)).toEqual(outcome);
  });

  it("throws any other failure, including a 503 that is not the provider's", () => {
    expect(() => keyConnectFromResponse(503, { error: "storage unavailable" })).toThrow(
      expect.objectContaining({ status: 503, message: "storage unavailable" }),
    );
    expect(() => keyConnectFromResponse(401, { error: "unauthorized" })).toThrow(expect.objectContaining({ status: 401 }));
  });
});

describe("keyRemoveFromResponse", () => {
  it.each([
    [200, { ...row, credential: null }, { kind: "saved", settings: { ...row, credential: null } }],
    [403, RECENT_AUTH, { kind: "step-up" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, MISMATCH, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j", (status, body, outcome) => {
    expect(keyRemoveFromResponse(status, body)).toEqual(outcome);
  });

  it("throws anything else", () => {
    expect(() => keyRemoveFromResponse(500, { error: "internal" })).toThrow(expect.objectContaining({ status: 500 }));
  });
});

describe("preferencesSaveFromResponse", () => {
  it.each([
    [200, row, { kind: "saved", settings: row }],
    [400, { error: "cap above operator default", code: "cap_above_operator_default" }, { kind: "cap-above" }],
    [400, { error: "invalid body" }, { kind: "invalid" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, MISMATCH, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j", (status, body, outcome) => {
    expect(preferencesSaveFromResponse(status, body)).toEqual(outcome);
  });

  it("throws anything else", () => {
    expect(() => preferencesSaveFromResponse(404, { error: "not found" })).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("keyStateOf", () => {
  const credential = settings.credential!;
  it.each([
    ["missing", { credential: null }, false, { kind: "missing" }],
    ["removed on this visit", { credential: null }, true, { kind: "removed" }],
    ["connected", { credential }, false, { kind: "connected", lastFour: "c0de", validatedAtMs: 1_000 }],
    ["connected again after a removal", { credential }, true, { kind: "connected", lastFour: "c0de", validatedAtMs: 1_000 }],
    ["invalid", { credential: { ...credential, status: "invalid" as const } }, false, { kind: "invalid", lastFour: "c0de" }],
  ])("%s", (_case, over, removedHere, state) => {
    expect(keyStateOf({ ...settings, ...over }, removedHere)).toEqual(state);
  });
});

describe("keyInputError", () => {
  it.each([
    ["sk-proj-abc123", null],
    ["  sk-proj-abc123  ", null],
    ["", "empty"],
    ["   ", "empty"],
    ["sk-", "malformed"],
    ["sk-proj abc", "malformed"],
    ["k".repeat(257), "malformed"],
  ])("%j → %s", (value, error) => {
    expect(keyInputError(value)).toBe(error);
  });
});

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [1, "less than $0.01"],
    [9_999, "less than $0.01"],
    [10_000, "$0.01"],
    [120_000, "$0.12"],
    [2_000_000, "$2.00"],
    [1_234_567_890, "$1,234.57"],
  ])("%i microdollars → %s", (micro, text) => {
    expect(formatUsd(micro)).toBe(text);
  });
});

describe("dollarsOf", () => {
  it.each([
    [2_000_000, "2.00"],
    [1_500_000, "1.50"],
    [10_000, "0.01"],
  ])("%i → %s", (micro, text) => {
    expect(dollarsOf(micro)).toBe(text);
  });
});

describe("capFromDollars", () => {
  const operator = 2_000_000;
  it.each([
    ["1", { kind: "cap", microdollars: 1_000_000 }],
    ["1.5", { kind: "cap", microdollars: 1_500_000 }],
    ["$0.25", { kind: "cap", microdollars: 250_000 }],
    [" 2.00 ", { kind: "cap", microdollars: 2_000_000 }],
    ["", { kind: "empty" }],
    ["0", { kind: "zero" }],
    ["0.00", { kind: "zero" }],
    ["abc", { kind: "invalid" }],
    ["1.234", { kind: "invalid" }],
    ["-1", { kind: "invalid" }],
    ["1e3", { kind: "invalid" }],
    ["2.01", { kind: "above" }],
  ])("%j → %j", (text, result) => {
    expect(capFromDollars(text, operator)).toEqual(result);
  });
});
