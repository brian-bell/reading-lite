import { RECENT_AUTH_WINDOW_MS } from "./constants";
import type { AuthenticatedPrincipal } from "./principal";

/** Inclusive 10-minute window from `authenticated_at_ms`. Future timestamps fail closed. */
export function isRecentAuth(authenticatedAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(authenticatedAtMs) || !Number.isFinite(nowMs)) return false;
  if (nowMs < authenticatedAtMs) return false;
  return nowMs - authenticatedAtMs <= RECENT_AUTH_WINDOW_MS;
}

export function principalHasRecentAuth(principal: AuthenticatedPrincipal | undefined, nowMs: number): boolean {
  if (!principal || principal.kind !== "session") return false;
  return isRecentAuth(principal.authenticatedAtMs, nowMs);
}
