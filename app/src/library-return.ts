import type { HistoryState, ParsedHistoryState } from "@tanstack/history";
import { currentLoadId } from "./reading-trail";

export interface LibraryReturnState {
  /** The document load that wrote this record; see currentLoadId. */
  load: string;
  /** The list entry's history position (@tanstack/history's `__TSR_index`). */
  index: number;
}

export type ReturnOrigin = "library" | "catalog";

const RETURN_KEY = {
  library: "libraryReturn",
  catalog: "catalogReturn",
} as const satisfies Record<ReturnOrigin, "libraryReturn" | "catalogReturn">;

export const RETURN_LABEL = {
  library: "Back to library",
  catalog: "Back to catalog",
} as const satisfies Record<ReturnOrigin, string>;

declare module "@tanstack/history" {
  interface HistoryState {
    libraryReturn?: LibraryReturnState;
    catalogReturn?: LibraryReturnState;
  }
}

export function originReturnState(origin: ReturnOrigin) {
  return (
    from: Partial<ParsedHistoryState> | undefined,
    loadId: string = currentLoadId(),
  ): Pick<HistoryState, "libraryReturn" | "catalogReturn"> => {
    const index = from?.__TSR_index;
    if (typeof index !== "number") return {};
    return { [RETURN_KEY[origin]]: { load: loadId, index } };
  };
}

function returnDelta(
  state: Partial<ParsedHistoryState> | undefined,
  origin: ReturnOrigin,
  loadId: string,
): number | undefined {
  const record = state?.[RETURN_KEY[origin]];
  const current = state?.__TSR_index;
  if (!record || record.load !== loadId || typeof current !== "number") return undefined;
  return record.index < current ? record.index - current : undefined;
}

/** The list this reading was opened from, when this load still has that entry behind it. */
export function readingReturn(
  state: Partial<ParsedHistoryState> | undefined,
  loadId: string = currentLoadId(),
): { origin: ReturnOrigin; delta: number } | undefined {
  for (const origin of ["catalog", "library"] as const) {
    const delta = returnDelta(state, origin, loadId);
    if (delta !== undefined) return { origin, delta };
  }
  return undefined;
}

export function carryReturn(
  prev: Partial<HistoryState> | undefined,
): Pick<HistoryState, "libraryReturn" | "catalogReturn"> {
  return { libraryReturn: prev?.libraryReturn, catalogReturn: prev?.catalogReturn };
}
