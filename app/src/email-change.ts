import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Changing the account email from the account page (#340.6.2), as the SPA's
// onChangeEmail. POST /api/auth/email-change always answers a generic 200, so
// the page can only say a link was sent if the address can be used; the
// emailed link (purpose=email_change) is confirmed on /auth/verify in this
// same browser.
//
// The route needs a sign-in from the last ten minutes, so a 401 or 403 means
// "sign in again", not "no access": the page offers a fresh sign-in link
// instead of the matrix's permission state.

export type EmailChangeOutcome =
  | { kind: "sent" }
  | { kind: "invalid" }
  | { kind: "step-up" }
  | { kind: "account-changed"; actingTenant?: string };

export function emailChangeFromResponse(status: number, body: unknown): EmailChangeOutcome {
  if (status === 200) return { kind: "sent" };
  if (status === 400) return { kind: "invalid" };
  if (status === 401 || status === 403) return { kind: "step-up" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to request email change");
}
