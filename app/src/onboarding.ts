// When the desk leads with the three steps (reading-lite-kl7y.9). Pure, so
// each rule is a row in test/onboarding.test.ts. DeskPage reads the facts.
//
// An empty desk is not an empty library. The desk's groups cover this visit,
// so a reader with older readings can still have a quiet desk. Emptiness is
// the library's first unfiltered page: offset 0, no rows, and no further page.
//
// The cached `needs_provider_key` clears the moment a key connects. A visit
// that already showed the steps keeps them while that page stays empty, so
// the save step opens in place. The next visit decides from the flag again.

import type { LibraryParams, LibraryResult } from "./library";

/** The library's first page, unfiltered: the read that says whether any reading exists. */
export const FIRST_LIBRARY_PAGE: LibraryParams = { offset: 0 };

export type LibraryEmptiness = "pending" | "empty" | "occupied" | "unknown";

/** Data already in hand wins over a failed refetch. A refusal is unknown, and the desk's own read shows it. */
export function libraryEmptinessOf(result: LibraryResult | undefined, failed: boolean): LibraryEmptiness {
  if (result === undefined) return failed ? "unknown" : "pending";
  if (result.state !== "ready") return "unknown";
  const { offset, readings, has_more } = result.page;
  if (offset === 0 && readings.length === 0 && has_more === false) return "empty";
  return "occupied";
}

/** Step 2. Step 3 is open exactly when this is "connected". */
export type KeyStep = "needed" | "connected";

export type DeskMode =
  | { kind: "deciding" }
  | { kind: "sections" }
  | { kind: "onboarding"; keyStep: KeyStep };

export interface DeskModeFacts {
  /** `needsProviderKey(identity)`, as cached. */
  keyNeeded: boolean;
  /** This visit has already shown the steps. */
  opened: boolean;
  /** Only read while `needsLibraryRead` holds. Ignored otherwise. */
  library: LibraryEmptiness;
}

/** The first page is read only while the steps could be shown. The loader passes `opened: false`. */
export function needsLibraryRead({ keyNeeded, opened }: Pick<DeskModeFacts, "keyNeeded" | "opened">): boolean {
  return keyNeeded || opened;
}

export function deskModeOf(facts: DeskModeFacts): DeskMode {
  if (!needsLibraryRead(facts)) return { kind: "sections" };
  switch (facts.library) {
    case "pending":
      return { kind: "deciding" };
    case "empty":
      return { kind: "onboarding", keyStep: facts.keyNeeded ? "needed" : "connected" };
    case "occupied":
    case "unknown":
      return { kind: "sections" };
    default: {
      const unreachable: never = facts.library;
      return unreachable;
    }
  }
}
