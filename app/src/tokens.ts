import { z } from "zod";
import type { AccountRead, AccountRefusal } from "./account-state";
import { ApiError } from "./api/errors";
import { actingTenantOf, messageOf } from "./reading";
import { formatSessionTime } from "./sessions";

// API tokens from GET /api/auth/tokens (#340.7, Phase 5 of #340). Fetched in
// the browser only, like the sessions list (ADR 0003). The projection mirrors
// the fields of ApiTokenListItemSchema (src/schemas/api.ts) this app reads;
// unknown fields pass through, and a malformed one is the retryable
// "unexpected body" error rather than a crash in a component. The list never
// carries a token's secret.

export const TokenListItemSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  format: z.string().min(1),
  scopes: z.array(z.string()),
  created_at_ms: z.number(),
  expires_at_ms: z.number(),
  revoked_at_ms: z.number().nullable(),
  last_used_at_ms: z.number().nullable(),
  usable: z.boolean(),
});
export type TokenListItem = z.infer<typeof TokenListItemSchema>;

export const TokensListSchema = z.looseObject({
  tokens: z.array(TokenListItemSchema),
});
export interface TokensList {
  tokens: TokenListItem[];
}

/** Account-scoped, so sign-in and sign-out drop it (src/auth/session.ts). */
export function tokensQueryKey(userId: string): readonly unknown[] {
  return ["tokens", userId];
}

export type TokensResult = AccountRead<TokensList>;

export function tokensFromResponse(status: number, body: unknown): TokensResult {
  if (status === 200) {
    const parsed = TokensListSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "tokens returned an unexpected body");
    return { state: "ready", value: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `tokens returned ${status}`);
}

/** The scopes a token can carry, in the SPA's order (API_SCOPES in src/control-plane/principal.ts). */
export const TOKEN_SCOPES = ["readings:read", "readings:write", "readings:import", "readings:delete"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * POST /api/auth/tokens (PostAuthTokensBodySchema). Without `expires_at_ms`
 * the backend gives the token the longest life, TOKEN_MAX_TTL_MS.
 */
export interface TokenCreateBody {
  name: string;
  scopes: TokenScope[];
  expires_at_ms?: number;
}

/** A token's longest life: 90 days (TOKEN_MAX_TTL_MS in the control plane). */
export const TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The optional expiry field's value, checked as the SPA's onCreateToken does
 * before any request: empty is the backend's default, and anything else must
 * be a real time after now and no more than 90 days away. The value is a
 * `datetime-local` string, read in the browser's own time zone.
 */
export type TokenExpiry =
  | { kind: "default" }
  | { kind: "at"; ms: number }
  | { kind: "invalid" }
  | { kind: "past" }
  | { kind: "too-far" };

export function tokenExpiryFrom(value: string, nowMs: number): TokenExpiry {
  if (value.trim() === "") return { kind: "default" };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { kind: "invalid" };
  if (ms <= nowMs) return { kind: "past" };
  if (ms > nowMs + TOKEN_MAX_TTL_MS) return { kind: "too-far" };
  return { kind: "at", ms };
}

/** The SPA's words for an expiry the form refuses. */
export const TOKEN_EXPIRY_ERRORS = {
  invalid: "Enter a valid expiry.",
  past: "Expiry must be in the future.",
  "too-far": "Expiry cannot be more than 90 days from now.",
} as const satisfies Record<Exclude<TokenExpiry["kind"], "default" | "at">, string>;

/** A time as a `datetime-local` value in the browser's time zone, for the field's min and max. */
export function datetimeLocalValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Usable tokens an account may hold (MAX_ACTIVE_TOKENS in the control plane). */
export const TOKEN_LIMIT = 10;

/** The SPA's words for an account at the limit. */
export const TOKEN_LIMIT_WARNING = `This account is at the ${TOKEN_LIMIT}-token limit. Revoke a token before creating another.`;

/** The backend's longest token name (PostAuthTokensBodySchema). */
export const TOKEN_NAME_MAX = 80;

const CreatedTokenSchema = z.looseObject({
  token: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
});

const RECENT_AUTH_REQUIRED = "recent authentication required";

/**
 * What POST /api/auth/tokens answered. `created` carries the token's secret,
 * the one time the backend returns it. 400 is `invalid`, and 409 is `limit`
 * (the account already has TOKEN_LIMIT usable tokens); a 403 that names
 * recent authentication is `step-up` (a sign-in from the last ten minutes is
 * needed), and any other 403 or a 412 refuses the account. A 401 and anything
 * else throw.
 */
export type TokenCreateOutcome =
  | { kind: "created"; id: string; name: string; secret: string }
  | { kind: "invalid" }
  | { kind: "step-up" }
  | { kind: "limit" }
  | AccountRefusal;

export function tokenCreateFromResponse(status: number, body: unknown): TokenCreateOutcome {
  if (status === 201) {
    const parsed = CreatedTokenSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "token create returned an unexpected body");
    return { kind: "created", id: parsed.data.id, name: parsed.data.name, secret: parsed.data.token };
  }
  if (status === 400) return { kind: "invalid" };
  if (status === 409) return { kind: "limit" };
  if (status === 403) return messageOf(body) === RECENT_AUTH_REQUIRED ? { kind: "step-up" } : { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to create token");
}

/**
 * What DELETE /api/auth/tokens/:id answered. A 404 is `gone`: the token is
 * not this account's to revoke any more — revoked, or removed, from another
 * tab — so the page treats it like a revoke and reads the list again. 403
 * and 412 are values so the page can render the shared state; a 401 and
 * anything else throw.
 */
export type TokenRevokeOutcome = { kind: "revoked" } | { kind: "gone" } | AccountRefusal;

export function tokenRevokeFromResponse(status: number, body: unknown): TokenRevokeOutcome {
  if (status === 200) return { kind: "revoked" };
  if (status === 404) return { kind: "gone" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 412) return { kind: "account-changed", actingTenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? "failed to revoke token");
}

/**
 * The list with every token in `revokedIds` shown revoked, as the SPA's
 * revoked-ids overlay does: a list read that started before the revoke
 * landed must not bring the token back as usable.
 */
export function withRevokedTokens(listed: TokensList, revokedIds: ReadonlySet<string>, nowMs: number): TokensList {
  if (revokedIds.size === 0) return listed;
  return {
    ...listed,
    tokens: listed.tokens.map((token) =>
      revokedIds.has(token.id) && token.usable
        ? { ...token, usable: false, revoked_at_ms: token.revoked_at_ms ?? nowMs }
        : token,
    ),
  };
}

/** The SPA's status word: revoked wins over expired, and a usable token is usable. */
export function tokenStatus(token: TokenListItem): "revoked" | "expired" | "usable" {
  if (token.revoked_at_ms != null) return "revoked";
  if (!token.usable) return "expired";
  return "usable";
}

/** The line the SPA prints for one token: name, format, and status. */
export function tokenHeading(token: TokenListItem): string {
  return `${token.name} (${token.format}) · ${tokenStatus(token)}`;
}

/** Created, expiry, and last use, as the SPA words them. */
export function tokenTimes(token: TokenListItem): string {
  const used = token.last_used_at_ms != null ? `last used ${formatSessionTime(token.last_used_at_ms)}` : "never used";
  return `Created ${formatSessionTime(token.created_at_ms)} · expires ${formatSessionTime(token.expires_at_ms)} · ${used}`;
}
