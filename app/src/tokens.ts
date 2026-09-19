import { z } from "zod";
import type { AccountRead } from "./account-state";
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
