import { describe, expect, it } from "vitest";
import type { LibraryPage, LibraryResult } from "../src/library";
import { deskModeOf, libraryEmptinessOf, needsLibraryRead, type LibraryEmptiness } from "../src/onboarding";

// The new reader's desk (reading-lite-kl7y.9): whether the first library page
// is empty, whether it is read, and which desk that produces.

const ready = (
  offset: number,
  hasMore: boolean,
  readings: LibraryPage["readings"] = [],
): LibraryResult => ({
  state: "ready",
  page: { readings, limit: 20, offset, has_more: hasMore },
});

const reading = { id: "rd_a", url: "https://example.com/a", status: "ready" } as const;

describe("library emptiness", () => {
  it.each<[string, LibraryResult | undefined, boolean, LibraryEmptiness]>([
    ["no answer yet", undefined, false, "pending"],
    ["a failed read with no page", undefined, true, "unknown"],
    ["a refused page", { state: "forbidden" }, false, "unknown"],
    ["a page for another account", { state: "account-changed", acting_tenant: "other" }, true, "unknown"],
    ["the first page, with nothing on it", ready(0, false), false, "empty"],
    ["an empty first page already in hand when a refetch failed", ready(0, false), true, "empty"],
    ["an empty first page that says more exist", ready(0, true), false, "occupied"],
    ["an empty later page", ready(20, false), false, "occupied"],
    ["a later page that also says more exist", ready(20, true), false, "occupied"],
    ["a first page with a reading", ready(0, false, [reading]), false, "occupied"],
    ["a first page with a reading that says more exist", ready(0, true, [reading]), false, "occupied"],
  ])("%s", (_case, result, failed, emptiness) => {
    expect(libraryEmptinessOf(result, failed)).toBe(emptiness);
  });
});

describe("whether the first page is read", () => {
  it.each<[string, boolean, boolean, boolean]>([
    ["a reader who arrived with a key", false, false, false],
    ["a keyless reader", true, false, true],
    ["a visit that already showed the steps", false, true, true],
    ["a keyless visit that already showed the steps", true, true, true],
  ])("%s", (_case, keyNeeded, opened, read) => {
    expect(needsLibraryRead({ keyNeeded, opened })).toBe(read);
  });
});

describe("desk mode", () => {
  it.each<[string, boolean, boolean, LibraryEmptiness, ReturnType<typeof deskModeOf>]>([
    ["a reader who arrived with a key, library empty", false, false, "empty", { kind: "sections" }],
    ["a reader who arrived with a key, library still loading", false, false, "pending", { kind: "sections" }],
    ["a reader who arrived with a key, library refused", false, false, "unknown", { kind: "sections" }],
    ["a reader who arrived with a key, library occupied", false, false, "occupied", { kind: "sections" }],
    ["the page is still loading", true, false, "pending", { kind: "deciding" }],
    ["the page is still loading on a visit that showed the steps", false, true, "pending", { kind: "deciding" }],
    ["no readings, and a key is needed", true, false, "empty", { kind: "onboarding", keyStep: "needed" }],
    ["no readings, the key connected on this visit", false, true, "empty", { kind: "onboarding", keyStep: "connected" }],
    ["no readings, still keyless after the steps opened", true, true, "empty", { kind: "onboarding", keyStep: "needed" }],
    ["a reading exists", true, false, "occupied", { kind: "sections" }],
    ["a reading arrived after the steps opened", false, true, "occupied", { kind: "sections" }],
    ["the list was refused or failed", true, false, "unknown", { kind: "sections" }],
    ["the list was refused after the steps opened", true, true, "unknown", { kind: "sections" }],
  ])("%s", (_case, keyNeeded, opened, library, mode) => {
    expect(deskModeOf({ keyNeeded, opened, library })).toEqual(mode);
  });
});
