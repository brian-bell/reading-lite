import { describe, expect, it, vi } from "vitest";
import { AttemptIo } from "../../src/attempt-io";
import type { ContentStore } from "../../src/modules/stores/content-store";

// The sweep of a revision this attempt's publication replaced. Its row is
// already gone; this decides which objects go with it.

const KEY_PREFIX = "readings/2026/04/26T200000Z-rd_1";

// The reading's current keys, as the store reports them: the live revision by
// default, so the superseded keys under test are unreferenced.
function ioWith(
  content: Pick<ContentStore, "deletePrefix" | "delete">,
  attemptId = "at_new",
  currentRawKey = `${KEY_PREFIX}/revisions/${attemptId}/raw.html`,
): AttemptIo {
  return new AttemptIo(
    { contentKeys: async () => ({ rawKey: currentRawKey, extractedKey: null, contentType: "text/html" }) } as never,
    {} as never,
    content as ContentStore,
    {} as never,
    {} as never,
    { id: "rd_1", url: "https://example.com/a", urlHash: "h", createdAt: "2026-04-26T20:00:00.000Z", keyPrefix: KEY_PREFIX, attemptId, attemptStartedAt: "2026-04-26T20:00:00.000Z", trigger: "reprocess", email: false },
  );
}

describe("AttemptIo.discardSupersededContent", () => {
  it("deletes a superseded revision's whole prefix", async () => {
    const content = { deletePrefix: vi.fn(async () => 2), delete: vi.fn(async () => undefined) };
    await ioWith(content).discardSupersededContent({
      rawKey: `${KEY_PREFIX}/revisions/at_old/raw.html`,
      extractedKey: `${KEY_PREFIX}/revisions/at_old/extracted.md`,
    });
    expect(content.deletePrefix).toHaveBeenCalledWith(`${KEY_PREFIX}/revisions/at_old/`);
    expect(content.delete).not.toHaveBeenCalled();
  });

  // Legacy content shares key_prefix with the live revision, so only its own
  // objects go, and only the ones the row named.
  it.each([
    ["with its extracted object", `${KEY_PREFIX}/extracted.md`, [`${KEY_PREFIX}/raw.html`, `${KEY_PREFIX}/extracted.md`]],
    ["raw only", null, [`${KEY_PREFIX}/raw.html`]],
  ])("deletes legacy-spelled content by key, %s", async (_label, extractedKey, expected) => {
    const content = { deletePrefix: vi.fn(async () => 0), delete: vi.fn(async () => undefined) };
    await ioWith(content).discardSupersededContent({ rawKey: `${KEY_PREFIX}/raw.html`, extractedKey });
    expect(content.delete).toHaveBeenCalledWith(expected);
    expect(content.deletePrefix).not.toHaveBeenCalled();
  });

  // Fail-closed guard, as discardUnreferencedContent has: the reading's
  // current keys are read first, and whatever they point at stays.
  it("refuses keys the reading still points at", async () => {
    const content = { deletePrefix: vi.fn(async () => 0), delete: vi.fn(async () => undefined) };
    await ioWith(content, "at_new", `${KEY_PREFIX}/revisions/at_old/raw.html`).discardSupersededContent({
      rawKey: `${KEY_PREFIX}/revisions/at_old/raw.html`,
      extractedKey: null,
    });
    expect(content.deletePrefix).not.toHaveBeenCalled();
    expect(content.delete).not.toHaveBeenCalled();
  });

  it("never deletes this attempt's own revision prefix", async () => {
    const content = { deletePrefix: vi.fn(async () => 0), delete: vi.fn(async () => undefined) };
    await ioWith(content, "at_new").discardSupersededContent({
      rawKey: `${KEY_PREFIX}/revisions/at_new/raw.html`,
      extractedKey: null,
    });
    expect(content.deletePrefix).not.toHaveBeenCalled();
    expect(content.delete).not.toHaveBeenCalled();
  });
});
