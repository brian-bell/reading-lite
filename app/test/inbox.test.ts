import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import {
  discardFromResponse,
  inboxItemFromResponse,
  inboxItemName,
  inboxItemSize,
  inboxListFromResponse,
  promoteFromResponse,
} from "../src/inbox";

// The inbox's pure halves (reading-lite-fy8t): what each REST route answered,
// and how an item is named and sized. The intake outcomes promote shares with
// the save page are owned by test/save.test.ts; here only promote's own
// statuses, and that the rest reach submitFromResponse, are pinned.

const META = {
  id: "in_1",
  url: "https://notes.example/slow-reading-week",
  title: "Slow reading week",
  markdown_bytes: 1200,
  created_at: "2026-09-29T10:00:00.000Z",
  updated_at: "2026-09-29T11:00:00.000Z",
};

describe("inboxListFromResponse", () => {
  it("reads the items, keeping fields it does not declare", () => {
    const body = { items: [{ ...META, extra: true }] };
    expect(inboxListFromResponse(200, body)).toEqual({ state: "ready", value: body });
  });

  it.each([
    [403, { error: "forbidden" }, { state: "forbidden" }],
    [
      412,
      { error: "expected tenant mismatch", acting_tenant: "usr_b" },
      { state: "account-changed", acting_tenant: "usr_b" },
    ],
  ])("reads %i as a value", (status, body, expected) => {
    expect(inboxListFromResponse(status, body)).toEqual(expected);
  });

  it.each([
    [200, { items: [{ ...META, markdown_bytes: "big" }] }, "inbox returned an unexpected body"],
    [401, { error: "unauthorized" }, "unauthorized"],
    [503, null, "inbox returned 503"],
  ])("throws for %i", (status, body, message) => {
    expect(() => inboxListFromResponse(status, body)).toThrow(new ApiError(status, message));
  });
});

describe("inboxItemFromResponse", () => {
  it("reads the item with its Markdown", () => {
    const body = { ...META, markdown: "# Slow reading week" };
    expect(inboxItemFromResponse(200, body)).toEqual({ state: "ready", value: body });
  });

  it.each([
    [404, { error: "not found" }, { state: "not-found" }],
    [403, { error: "forbidden" }, { state: "forbidden" }],
    [412, { acting_tenant: "usr_b" }, { state: "account-changed", acting_tenant: "usr_b" }],
  ])("reads %i as a value", (status, body, expected) => {
    expect(inboxItemFromResponse(status, body)).toEqual(expected);
  });

  it.each([
    [200, META, "inbox item returned an unexpected body"],
    [500, { error: "boom" }, "boom"],
  ])("throws for %i", (status, body, message) => {
    expect(() => inboxItemFromResponse(status, body)).toThrow(new ApiError(status, message));
  });
});

describe("promoteFromResponse", () => {
  it.each([
    [404, { error: "not found" }, { kind: "gone" }],
    [413, { error: "markdown too large", code: "markdown_too_large" }, { kind: "too-large" }],
    // The intake outcomes, read by the save page's own mapping.
    [202, { id: "rd_1", status: "pending", inbox_item_id: "in_1" }, { kind: "accepted", id: "rd_1" }],
    [
      200,
      { id: "rd_1", status: "ready", inbox_item_id: "in_1" },
      { kind: "existing", id: "rd_1", notice: "already-saved" },
    ],
  ])("reads %i", (status, body, expected) => {
    expect(promoteFromResponse(status, body)).toEqual(expected);
  });
});

describe("discardFromResponse", () => {
  it.each([
    [204, null, { kind: "discarded" }],
    // Already gone is what the reader asked for.
    [404, { error: "not found" }, { kind: "discarded" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [412, { acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("reads %i", (status, body, expected) => {
    expect(discardFromResponse(status, body)).toEqual(expected);
  });

  it("throws for anything else", () => {
    expect(() => discardFromResponse(503, null)).toThrow(new ApiError(503, "discard returned 503"));
  });
});

describe("inboxItemName", () => {
  it.each([
    [{ title: "Slow reading week", url: META.url }, "Slow reading week"],
    [{ title: null, url: META.url }, META.url],
  ])("names %o", (item, expected) => {
    expect(inboxItemName(item)).toBe(expected);
  });
});

describe("inboxItemSize", () => {
  it.each([
    [1, "1 byte"],
    [840, "840 bytes"],
    [1024, "1 KB"],
    [12_800, "13 KB"],
    [126_976, "124 KB"],
  ])("sizes %i bytes", (bytes, expected) => {
    expect(inboxItemSize(bytes)).toBe(expected);
  });
});
