import { z } from "zod";
import type { AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// The desk (reading-lite-kl7y.6): at most three readings the reader means to
// read next. The writes are POST /api/desk and DELETE /api/desk/:id
// (docs/api.md, Desk routes); each answers the whole desk as ids in position
// order. Pure, so every mapping is tested without a DOM; api/desk.ts does the
// requests and DeskToggle.tsx renders what comes out.
//
// A reading's own place on the desk is its `desk_position`, on the list row
// and the reading detail. Whether the desk is full is known only from the
// last write's answer, kept under `deskIdsQueryKey` for the page session:
// there is no desk read yet (kl7y.7 adds GET /api/desk), so a page that has
// made no write learns the desk is full from the 409.

export const DESK_CAP = 3;
export const DESK_FULL_COPY = "Three readings at a time";
export const DESK_NOT_READY_COPY = "Only ready readings can go on the desk";

/** Everything the desk writes refresh; the ids below sit under it. */
export const DESK_QUERY_ROOT = ["desk"] as const;
export const deskIdsQueryKey = ["desk", "ids"] as const;

const DeskWriteSchema = z.looseObject({ desk: z.array(z.string()).max(DESK_CAP) });

export type DeskWriteOutcome =
  | { kind: "desk"; desk: string[] }
  | { kind: "full" }
  | { kind: "not-ready" }
  | { kind: "not-found" }
  | AccountRefusal;

export function deskWriteFromResponse(status: number, body: unknown): DeskWriteOutcome {
  if (status === 200) {
    const parsed = DeskWriteSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "desk returned an unexpected body");
    return { kind: "desk", desk: parsed.data.desk };
  }
  if (status === 404) return { kind: "not-found" };
  if (status === 409) {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (code === "desk_full") return { kind: "full" };
    if (code === "not_ready") return { kind: "not-ready" };
  }
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `desk returned ${status}`);
}

/** Whether a reading not already on the desk can be put there, by the last desk this page saw. */
export function deskIsFullFor(id: string, knownDesk: readonly string[] | undefined): boolean {
  return knownDesk !== undefined && !knownDesk.includes(id) && knownDesk.length >= DESK_CAP;
}
