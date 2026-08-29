export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Durable cookie lifetime: 90 days. Must be set so login survives browser restart. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7_776_000;
export const SESSION_LAST_SEEN_COALESCE_MS = 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS = 10;

export const SESSION_COOKIE_NAME = "__Host-session";

export const LOGIN_PURPOSE = "login" as const;
export type AuthChallengePurpose = "login" | "email_change";

export const REDEMPTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const USER_AGENT_LABEL_MAX = 80;
