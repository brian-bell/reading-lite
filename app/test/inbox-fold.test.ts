import { describe, expect, it } from "vitest";
import {
  deskInboxFold,
  deskQuietOf,
  inboxWriteEffect,
  promoteFromResponse,
  type InboxItemMeta,
} from "../src/inbox";

// The desk's inbox fold (reading-lite-kl7y.8): what one list read shows, when
// the desk may say it is empty, and whether a write drops the staged row.

const item = (id: string, title: string | null): InboxItemMeta => ({
  id,
  url: `https://example.com/${id}`,
  title,
  markdown_bytes: 40,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
});

const zebra = item("in_3", "Zebra");
const amber = item("in_1", "Amber");
const moth = item("in_2", "Moth");
const nadir = item("in_4", "Nadir");
const quartz = item("in_5", "Quartz");
const yarn = item("in_6", "Yarn");
const five = [zebra, amber, moth, nadir, quartz];
const six = [...five, yarn];

describe("deskInboxFold", () => {
  it("is empty when the list has no items", () => {
    expect(deskInboxFold({ kind: "ready", value: { items: [] } })).toEqual({ kind: "empty" });
  });

  it("shows five items in the order given", () => {
    expect(deskInboxFold({ kind: "ready", value: { items: five } })).toEqual({
      kind: "staged",
      shown: [zebra, amber, moth, nadir, quartz],
      total: 5,
    });
  });

  it("shows the first five of six in the order given", () => {
    expect(deskInboxFold({ kind: "ready", value: { items: six } })).toEqual({
      kind: "staged",
      shown: [zebra, amber, moth, nadir, quartz],
      total: 6,
    });
  });

  it("leaves a null title intact", () => {
    const untitled = item("in_u", null);
    expect(deskInboxFold({ kind: "ready", value: { items: [untitled] } })).toEqual({
      kind: "staged",
      shown: [
        {
          id: "in_u",
          url: "https://example.com/in_u",
          title: null,
          markdown_bytes: 40,
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z",
        },
      ],
      total: 1,
    });
  });

  it("is pending while the list has not settled", () => {
    expect(deskInboxFold({ kind: "loading" })).toEqual({ kind: "pending" });
  });

  it.each([
    ["forbidden", { kind: "forbidden" } as const, { kind: "forbidden" }],
    ["account-changed without a tenant", { kind: "account-changed" } as const, { kind: "account-changed" }],
    [
      "account-changed naming the tenant",
      { kind: "account-changed", actingTenant: "ten_other" } as const,
      { kind: "account-changed", actingTenant: "ten_other" },
    ],
    [
      "a server error",
      { kind: "server-error", message: "inbox returned 500" } as const,
      { kind: "error", message: "inbox returned 500" },
    ],
  ])("blocks on %s", (_label, view, block) => {
    expect(deskInboxFold(view)).toEqual({ kind: "blocked", block });
  });

  it("blocks offline when nothing was loaded", () => {
    expect(deskInboxFold({ kind: "offline" })).toEqual({ kind: "blocked", block: { kind: "offline" } });
  });

  it("keeps a cached list while offline", () => {
    expect(deskInboxFold({ kind: "offline", value: { items: six } })).toEqual({
      kind: "staged",
      shown: [zebra, amber, moth, nadir, quartz],
      total: 6,
    });
    expect(deskInboxFold({ kind: "offline", value: { items: [] } })).toEqual({ kind: "empty" });
  });
});

describe("deskQuietOf", () => {
  it("occupies the desk when a reading group has rows", () => {
    expect(deskQuietOf(false, { kind: "pending" })).toBe("occupied");
    expect(deskQuietOf(false, { kind: "empty" })).toBe("occupied");
  });

  it("withholds the empty sentence while the inbox has not settled", () => {
    expect(deskQuietOf(true, { kind: "pending" })).toBe("withheld");
  });

  it("is empty only when the inbox is empty", () => {
    expect(deskQuietOf(true, { kind: "empty" })).toBe("empty");
  });

  it("occupies the desk when items are staged or the list is blocked", () => {
    expect(deskQuietOf(true, { kind: "staged", shown: [amber], total: 1 })).toBe("occupied");
    expect(deskQuietOf(true, { kind: "blocked", block: { kind: "offline" } })).toBe("occupied");
    expect(deskQuietOf(true, { kind: "blocked", block: { kind: "forbidden" } })).toBe("occupied");
  });
});

describe("inboxWriteEffect", () => {
  it("drops a discard, a missing item, and a promote the server did not retain", () => {
    expect(inboxWriteEffect({ kind: "discarded" })).toBe("drop");
    expect(inboxWriteEffect({ kind: "gone" })).toBe("drop");
    expect(inboxWriteEffect({ kind: "accepted", id: "rd_1", retained: false })).toBe("drop");
    expect(inboxWriteEffect({ kind: "existing", id: "rd_2", retained: false })).toBe("drop");
  });

  it("retains a promote the server kept", () => {
    expect(inboxWriteEffect({ kind: "accepted", id: "rd_1", retained: true })).toBe("retain");
    expect(inboxWriteEffect({ kind: "existing", id: "rd_2", notice: "already-saved", retained: true })).toBe("retain");
  });

  it("keeps the row when the write did not remove it", () => {
    expect(inboxWriteEffect({ kind: "too-large" })).toBe("keep");
    expect(inboxWriteEffect({ kind: "forbidden" })).toBe("keep");
    expect(inboxWriteEffect({ kind: "already-processing" })).toBe("keep");
    expect(inboxWriteEffect({ kind: "invalid", message: "That URL can't be saved." })).toBe("keep");
    expect(inboxWriteEffect({ kind: "account-changed", actingTenant: "ten_a" })).toBe("keep");
    expect(inboxWriteEffect({ kind: "unavailable", id: "rd_9" })).toBe("keep");
  });
});

describe("promoteFromResponse", () => {
  it("sets retained only when the body says true", () => {
    expect(promoteFromResponse(202, { id: "rd_1", inbox_item_retained: true })).toEqual({
      kind: "accepted",
      id: "rd_1",
      retained: true,
    });
    expect(promoteFromResponse(202, { id: "rd_1" })).toEqual({ kind: "accepted", id: "rd_1", retained: false });
    expect(promoteFromResponse(202, { id: "rd_1", inbox_item_retained: "true" })).toEqual({
      kind: "accepted",
      id: "rd_1",
      retained: false,
    });
    expect(promoteFromResponse(200, { id: "rd_2", status: "ready", inbox_item_retained: true })).toEqual({
      kind: "existing",
      id: "rd_2",
      notice: "already-saved",
      retained: true,
    });
    expect(promoteFromResponse(200, { id: "rd_3", status: "pending" })).toEqual({
      kind: "existing",
      id: "rd_3",
      notice: "still-processing",
      retained: false,
    });
  });

  it("reads promote's own statuses before the save page's", () => {
    expect(promoteFromResponse(404, null)).toEqual({ kind: "gone" });
    expect(promoteFromResponse(413, { error: "markdown_too_large" })).toEqual({ kind: "too-large" });
  });
});
