export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Durable cookie lifetime: 90 days. Must be set so login survives browser restart. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7_776_000;
export const SESSION_LAST_SEEN_COALESCE_MS = 60 * 60 * 1000;
export const TOKEN_LAST_USED_COALESCE_MS = SESSION_LAST_SEEN_COALESCE_MS;
export const TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS = 10;
export const MAX_ACTIVE_TOKENS = 10;
/** Display name on minted API tokens. */
export const TOKEN_NAME_MAX = 80;
/** Fresh magic-link confirmation window for step-up (API tokens, email change, account delete). */
export const RECENT_AUTH_WINDOW_MS = 10 * 60 * 1000;
export const SESSION_CAP_WARNING =
  "This account is at the 10-session limit. Signing in from another device will sign out the least recently used session.";

export const SESSION_COOKIE_NAME = "__Host-session";
/** Same-origin SPA path in the magic-link URL. Pages must SPA-fallback this route. */
export const MAGIC_LINK_VERIFY_PATH = "/auth/verify";

export const LOGIN_PURPOSE = "login" as const;
export const EMAIL_CHANGE_PURPOSE = "email_change" as const;
export type AuthChallengePurpose = typeof LOGIN_PURPOSE | typeof EMAIL_CHANGE_PURPOSE;

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
/** Singleton GlobalUsageGuard — one fixed name, same pattern as AUTH_RATE_GUARD_NAME. */
export const GLOBAL_USAGE_GUARD_NAME = "global-usage-guard";

/** TenantUsageGuard: sliding window for every intake write request. */
export const INGRESS_REQUEST_WINDOW_MS = 60 * 60 * 1000;
/** Held reading-slot reservations expire if never committed or released. */
export const READING_RESERVATION_TTL_MS = 60 * 60 * 1000;
/** Undispatched paid-work holds are released after compensation has had time to run. */
export const SPEND_RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Crash-timeout for a processing lease; heartbeat/renew must beat this. Stub, not calibrated. */
export const PROCESSING_LEASE_TTL_MS = 10 * 60 * 1000;
/** Heartbeat interval while embed/summarize is in flight. Stub, not calibrated. */
export const PROCESSING_LEASE_HEARTBEAT_MS = 30 * 1000;
/** READING_JOBS.send delay on concurrency contention. Stub, not calibrated. */
export const PROCESSING_DEFER_DELAY_SECONDS = 15;
/** Max age a DeferPaidWorkError retry loop may run before markFailed. Stub, not calibrated. */
export const PROCESSING_DEFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
