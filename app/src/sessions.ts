import { z } from "zod";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";

// Browser sessions from GET /api/auth/sessions (#340.1, Phase 5 of #340).
// Fetched in the browser only: account pages are not part of the server
// render (ADR 0003). The projection declares what the account page shows;
// unknown fields pass through, and a malformed field this app reads is the
// retryable "unexpected body" error rather than a crash in a component.

export const SessionListItemSchema = z.looseObject({
  id: z.string().min(1),
  current: z.boolean(),
  authenticated_at_ms: z.number(),
  last_seen_at_ms: z.number(),
  revoked_at_ms: z.number().nullable(),
  revocation_reason: z.string().nullable(),
  user_agent_label: z.string().nullable(),
  usable: z.boolean(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const SessionsListSchema = z.looseObject({
  sessions: z.array(SessionListItemSchema),
  session_cap_warning: z.string().nullable(),
});
export interface SessionsList {
  sessions: SessionListItem[];
  session_cap_warning: string | null;
}

/** Account-scoped, so sign-in and sign-out drop it (src/auth/session.ts). */
export function sessionsQueryKey(userId: string): readonly unknown[] {
  return ["sessions", userId];
}

/**
 * What a reader sees for GET /api/auth/sessions. 403 and 412 are values, as
 * they are for the library and a reading, so the page renders the shared
 * state; a 401 and anything unexpected throw.
 */
export type SessionsResult =
  | { state: "ready"; listed: SessionsList }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

export function sessionsFromResponse(status: number, body: unknown): SessionsResult {
  if (status === 200) {
    const parsed = SessionsListSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "sessions returned an unexpected body");
    return { state: "ready", listed: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `sessions returned ${status}`);
}

/**
 * What DELETE /api/auth/sessions/:id and POST …/revoke-all answered. 403 and
 * 412 are values so the page can render the shared state (and a write's 403
 * can still become account-changed after asking who is signed in now). A 401
 * and anything else throw: the 401 through the mutation cache becomes the
 * shell's expired-session page.
 */
export type RevokeOutcome =
  | { kind: "revoked" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string };

export function revokeFromResponse(status: number, body: unknown, fallback: string): RevokeOutcome {
  if (status === 200) return { kind: "revoked" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? fallback);
}

/**
 * The line the SPA prints for one session: browser label, this-device mark,
 * and revoked/expired when the session is no longer usable.
 */
export function sessionHeading(session: SessionListItem): string {
  const name = session.user_agent_label ?? "Unknown browser";
  const here = session.current ? " (this device)" : "";
  const state = session.revoked_at_ms
    ? ` · revoked${session.revocation_reason ? ` (${session.revocation_reason})` : ""}`
    : session.usable
      ? ""
      : " · expired";
  return `${name}${here}${state}`;
}

export function formatSessionTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
