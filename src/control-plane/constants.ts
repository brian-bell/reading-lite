export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Durable cookie lifetime: 90 days. Must be set so login survives browser restart. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7_776_000;
export const SESSION_LAST_SEEN_COALESCE_MS = 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS = 10;
/** Fresh magic-link confirmation window for step-up (API tokens, email change, account delete). */
export const RECENT_AUTH_WINDOW_MS = 10 * 60 * 1000;
export const SESSION_CAP_WARNING =
  "This account is at the 10-session limit. Signing in from another device will sign out the least recently used session.";

export const SESSION_COOKIE_NAME = "__Host-session";
/** Same-origin SPA path in the magic-link URL. Pages must SPA-fallback this route. */
export const MAGIC_LINK_VERIFY_PATH = "/auth/verify";

export const LOGIN_PURPOSE = "login" as const;
export type AuthChallengePurpose = "login" | "email_change";

export const REDEMPTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const USER_AGENT_LABEL_MAX = 80;

/** AuthRateGuard: per-email ceiling for actual magic-link sends. */
export const AUTH_RATE_EMAIL_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_RATE_EMAIL_MAX = 5;
/** AuthRateGuard: per-coarse-IP ceiling for every challenge request (flood control). */
export const AUTH_RATE_IP_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_RATE_IP_MAX = 20;
/** AuthRateGuard: global ceiling for actual magic-link sends. */
export const AUTH_RATE_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const AUTH_RATE_GLOBAL_MAX = 200;
export const AUTH_RATE_GUARD_NAME = "auth-rate-guard";
