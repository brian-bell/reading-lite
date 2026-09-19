import {
  MAX_ACTIVE_TOKENS,
  TOKEN_MAX_TTL_MS,
  TOKEN_NAME_MAX,
} from "./constants";
import { formatCredential, mintSecretHex, type RandomBytes } from "./credential";
import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import type { ControlPlaneDb } from "./db";
import { fromTimestamp, toTimestamp } from "./pg-time";
import {
  mintTokenId,
  parseTokenId,
  type TokenId,
  type UserId,
  type UuidSource,
} from "./ids";
import { API_SCOPES, type ApiScope } from "./principal";

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export interface TokenListItem {
  id: string;
  name: string;
  format: "legacy" | "standard";
  scopes: ApiScope[];
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  last_used_at_ms: number | null;
  user_agent_label: string | null;
  usable: boolean;
}

export interface CreatedApiToken {
  token: string;
  id: TokenId;
  name: string;
  scopes: ApiScope[];
  created_at_ms: number;
  expires_at_ms: number;
}

export type CreateApiTokenResult =
  | { kind: "ok"; created: CreatedApiToken }
  | { kind: "cap" }
  | { kind: "invalid_name" }
  | { kind: "invalid_scopes" }
  | { kind: "invalid_expiry" };

interface TokenDbRow {
  id: string;
  name: string;
  format: "legacy" | "standard";
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  user_agent_label: string | null;
}

export function normalizeTokenName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > TOKEN_NAME_MAX) return null;
  return name;
}

export function uniqueApiScopes(scopes: readonly string[]): ApiScope[] | null {
  if (scopes.length === 0) return null;
  const unique: ApiScope[] = [];
  const seen = new Set<ApiScope>();
  for (const scope of scopes) {
    if (!API_SCOPE_SET.has(scope)) return null;
    const typed = scope as ApiScope;
    if (seen.has(typed)) continue;
    seen.add(typed);
    unique.push(typed);
  }
  if (unique.length === 0) return null;
  return unique.slice().sort();
}

export function tokenUsable(
  row: { revoked_at_ms: number | null; expires_at_ms: number },
  nowMs: number,
): boolean {
  return row.revoked_at_ms == null && row.expires_at_ms > nowMs;
}

export async function countActiveApiTokens(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number },
): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM api_tokens
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    input.userId,
    toTimestamp(input.nowMs),
  );
  return row?.n ?? 0;
}

export async function createApiToken(
  db: ControlPlaneDb,
  input: {
    userId: UserId;
    name: string;
    scopes: readonly string[];
    expiresAtMs?: number;
    nowMs: number;
    authRoot: AuthRoot;
    userAgentLabel: string | null;
    randomBytes?: RandomBytes;
    newUuid?: UuidSource;
  },
): Promise<CreateApiTokenResult> {
  const name = normalizeTokenName(input.name);
  if (!name) return { kind: "invalid_name" };
  const scopes = uniqueApiScopes(input.scopes);
  if (!scopes) return { kind: "invalid_scopes" };
  const expiresAtMs = input.expiresAtMs ?? input.nowMs + TOKEN_MAX_TTL_MS;
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= input.nowMs || expiresAtMs > input.nowMs + TOKEN_MAX_TTL_MS) {
    return { kind: "invalid_expiry" };
  }

  // Admission is the INSERT … SELECT WHERE count < 10 and its change count
  // (results[0].changes !== 1 → cap). Under READ COMMITTED two creates could
  // both count 9, so the user row lock serializes them first, as D1's single
  // writer did.
  const tokenId = mintTokenId(input.newUuid);
  const secret = mintSecretHex(input.randomBytes);
  const secretHmac = await hmacHex(await deriveHmacKey(input.authRoot, "api_token"), secret);
  const now = toTimestamp(input.nowMs);

  const results = await db.transaction(async (tx) => {
    await tx.first("SELECT id FROM users WHERE id = ? FOR UPDATE", input.userId);
    return tx.batch([
      {
        sql: `INSERT INTO api_tokens (
                id, user_id, name, format, secret_hmac, hash_key_version,
                created_at, expires_at, user_agent_label
              )
              SELECT ?, ?, ?, 'standard', ?, ?, ?, ?, ?
              WHERE (
                SELECT COUNT(*) FROM api_tokens
                WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
              ) < ?`,
        params: [
          tokenId,
          input.userId,
          name,
          secretHmac,
          input.authRoot.version,
          now,
          toTimestamp(expiresAtMs),
          input.userAgentLabel,
          input.userId,
          now,
          MAX_ACTIVE_TOKENS,
        ],
      },
      ...scopes.map((scope) => ({
        sql: `INSERT INTO api_token_scopes (token_id, scope)
              SELECT ?, ?
              WHERE EXISTS (SELECT 1 FROM api_tokens WHERE id = ?)`,
        params: [tokenId, scope, tokenId],
      })),
    ]);
  });

  if ((results[0]?.changes ?? 0) !== 1) return { kind: "cap" };

  return {
    kind: "ok",
    created: {
      token: formatCredential(tokenId, secret),
      id: tokenId,
      name,
      scopes,
      created_at_ms: input.nowMs,
      expires_at_ms: expiresAtMs,
    },
  };
}

export async function listApiTokensForUser(
  db: ControlPlaneDb,
  input: { userId: UserId; nowMs: number },
): Promise<{ tokens: TokenListItem[] }> {
  // D1 sorted a NULL last use last under DESC; PostgreSQL sorts it first.
  const rows = await db.all<TokenDbRow>(
    `SELECT id, name, format, created_at, expires_at, revoked_at,
            last_used_at, user_agent_label
     FROM api_tokens
     WHERE user_id = ?
     ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    input.userId,
  );
  const scopeRows = await db.all<{ token_id: string; scope: string }>(
    `SELECT s.token_id, s.scope
     FROM api_token_scopes s
     JOIN api_tokens t ON t.id = s.token_id
     WHERE t.user_id = ?`,
    input.userId,
  );
  const scopesByToken = new Map<string, ApiScope[]>();
  for (const row of scopeRows) {
    if (!API_SCOPE_SET.has(row.scope)) continue;
    const list = scopesByToken.get(row.token_id) ?? [];
    list.push(row.scope as ApiScope);
    scopesByToken.set(row.token_id, list);
  }
  return {
    tokens: rows.map((row) => {
      const times = {
        created_at_ms: fromTimestamp(row.created_at),
        expires_at_ms: fromTimestamp(row.expires_at),
        revoked_at_ms: fromTimestamp(row.revoked_at),
        last_used_at_ms: fromTimestamp(row.last_used_at),
      };
      return {
        id: row.id,
        name: row.name,
        format: row.format,
        scopes: (scopesByToken.get(row.id) ?? []).slice().sort(),
        ...times,
        user_agent_label: row.user_agent_label,
        usable: tokenUsable(times, input.nowMs),
      };
    }),
  };
}

export async function revokeOwnedApiToken(
  db: ControlPlaneDb,
  input: { tokenId: string; userId: UserId; nowMs: number },
): Promise<"ok" | "not_found"> {
  const tokenId = parseTokenId(input.tokenId);
  if (!tokenId) return "not_found";
  const row = await db.first<{ id: string; user_id: string; revoked_at: string | null }>(
    "SELECT id, user_id, revoked_at FROM api_tokens WHERE id = ?",
    tokenId,
  );
  if (!row || row.user_id !== input.userId) return "not_found";
  if (row.revoked_at == null) {
    await db.run(
      `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      toTimestamp(input.nowMs),
      tokenId,
    );
  }
  return "ok";
}
