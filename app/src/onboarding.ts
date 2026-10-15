import type { LibraryParams, LibraryResult } from "./library";

export const FIRST_LIBRARY_PAGE: LibraryParams = { offset: 0 };

export type LibraryEmptiness = "pending" | "empty" | "occupied" | "unknown";

export function libraryEmptinessOf(result: LibraryResult | undefined, failed: boolean): LibraryEmptiness {
  if (result === undefined) return failed ? "unknown" : "pending";
  if (result.state !== "ready") return "unknown";
  const { offset, readings, has_more } = result.page;
  if (offset === 0 && readings.length === 0 && has_more === false) return "empty";
  return "occupied";
}

export type KeyStep = "needed" | "connected";

export type KeyPresence = "unknown" | "absent" | "present";

export function keyStepOf(step: KeyStep, presence: KeyPresence): KeyStep {
  if (presence === "absent") return "needed";
  return step;
}

export type DeskMode =
  | { kind: "deciding" }
  | { kind: "sections" }
  | { kind: "onboarding"; keyStep: KeyStep };

export interface DeskModeFacts {
  keyNeeded: boolean;
  shownThisMount: boolean;
  library: LibraryEmptiness;
}

export function needsLibraryRead({ keyNeeded, shownThisMount }: Pick<DeskModeFacts, "keyNeeded" | "shownThisMount">): boolean {
  return keyNeeded || shownThisMount;
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
