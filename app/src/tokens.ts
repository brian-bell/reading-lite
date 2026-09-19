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
