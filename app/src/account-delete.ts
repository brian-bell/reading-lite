import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Account deletion from DELETE /api/account (#340.8, acceptance matrix,
// Account deletion). The backend starts suppression: the account is marked
// deleting, every session and API token is revoked, and this tab's cookie is
// cleared. The data wipe starts after a seven-day grace; sign-in is refused
// during it (the account is no longer active), so there is no undo here.

/** The backend's literal: `{ "confirm": "delete" }` (DeleteAccountBodySchema). */
export const DELETE_CONFIRM_PHRASE = "delete";

/** requireRecentAuth's refusal (src/middleware.ts); every other 403 is `forbidden`. */
export const RECENT_AUTH_REQUIRED = "recent authentication required";

/**
 * What DELETE /api/account answered. Step-up is its own outcome because the
 * reader can fix it with a fresh sign-in link; the other refusals are the
 * shared page states. A 401 and anything else throw: the 401 through the
 * mutation cache becomes the shell's expired-session page.
 */
export type AccountDeleteOutcome =
  | { kind: "deleted" }
  | { kind: "step-up" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string };

export function accountDeleteFromResponse(status: number, body: unknown): AccountDeleteOutcome {
  if (status === 200) return { kind: "deleted" };
  if (status === 403) {
    return messageOf(body) === RECENT_AUTH_REQUIRED ? { kind: "step-up" } : { kind: "forbidden" };
  }
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to delete account");
}
