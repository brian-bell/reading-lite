import { describe, expect, it } from "vitest";
import { currentLoadId } from "../src/reading-trail";
import { saveNoticeOf, saveNoticeState } from "../src/save-notice";

// The notice in history state (#432). Same rule as the return trail: it
// belongs to the history entry the save wrote, and only to this document load,
// so a reload cannot bring it back. What it says is the reading page's, and
// the tests that render it are the coverage for that.

describe("saveNoticeOf", () => {
  it("reads the notice a location from this load carries", () => {
    expect(saveNoticeOf({ saveNotice: { load: currentLoadId(), kind: "already-saved" } })).toBe("already-saved");
    expect(saveNoticeOf({ saveNotice: { load: currentLoadId(), kind: "still-processing" } })).toBe("still-processing");
  });

  it("is nothing without state, as a shared or plain link is", () => {
    expect(saveNoticeOf(undefined)).toBeUndefined();
    expect(saveNoticeOf({})).toBeUndefined();
  });

  // A reload keeps window.history.state, so the notice it holds would come
  // back with the page. Another document load wrote it, so it does not count.
  it("drops a notice written by another document load", () => {
    expect(saveNoticeOf({ saveNotice: { load: "an earlier load", kind: "already-saved" } })).toBeUndefined();
  });
});

describe("saveNoticeState", () => {
  it("stamps the notice with this load", () => {
    expect(saveNoticeState("already-saved")).toEqual({ load: currentLoadId(), kind: "already-saved" });
  });

  it("round-trips through the selector", () => {
    expect(saveNoticeOf({ saveNotice: saveNoticeState("still-processing") })).toBe("still-processing");
  });
});
