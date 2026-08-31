import { parsePresentedToken } from "./bearer";
import { deriveHmacKey, hmacHex, timingSafeEqualHex, type AuthRoot } from "./crypto";
import type { ControlPlaneDb } from "./db";
import { createApiTokenPrincipal, type AuthenticatedPrincipal } from "./principal";
import { authenticateSession } from "./sessions";

export type AuthVerdict =
  | { kind: "ok"; principal: AuthenticatedPrincipal }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

export interface AuthenticateBearerInput {
  authorization: string | undefined;
  authRoot: AuthRoot;
  previousAuthRoot?: AuthRoot;
  nowMs: number;
}

interface TokenRow {
  id: string;
  user_id: string;
  format: string;
  secret_hmac: string;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

interface UserRow {
  id: string;
  status: string;
}

export interface AuthenticateRequestInput {
  authorization: string | undefined;
  cookieHeader: string | undefined;
  cookieAllowed: boolean;
  authRoot: AuthRoot;
  previousAuthRoot?: AuthRoot;
  nowMs: number;
}

export function hasBearerAuthorization(header: string | undefined): boolean {
  if (!header) return false;
  const value = header.trim();
  return /^Bearer(?:\s+|$)/i.test(value);
}

export async function authenticateRequest(
  db: ControlPlaneDb,
  input: AuthenticateRequestInput,
): Promise<AuthVerdict> {
  if (hasBearerAuthorization(input.authorization)) {
    return authenticateBearer(db, {
      authorization: input.authorization,
      authRoot: input.authRoot,
      ...(input.previousAuthRoot ? { previousAuthRoot: input.previousAuthRoot } : {}),
      nowMs: input.nowMs,
    });
  }
  if (!input.cookieAllowed) return { kind: "unauthenticated" };
  return authenticateSession(db, {
    cookieHeader: input.cookieHeader,
    authRoot: input.authRoot,
    ...(input.previousAuthRoot ? { previousAuthRoot: input.previousAuthRoot } : {}),
    nowMs: input.nowMs,
  });
}

export async function authenticateBearer(
  db: ControlPlaneDb,
  input: AuthenticateBearerInput,
): Promise<AuthVerdict> {
  const rawToken = parseAuthorizationRaw(input.authorization);
  if (!rawToken) return { kind: "unauthenticated" };
  const presented = parsePresentedToken(rawToken);
  if (!presented) return { kind: "unauthenticated" };

  let match =
    presented.format === "standard"
      ? await lookupStandardToken(db, presented.selector, presented.secret, input.authRoot, input.previousAuthRoot)
      : await lookupLegacyToken(db, presented.secret, input.authRoot, input.previousAuthRoot);
  if (!match && presented.format === "standard") {
    match = await lookupLegacyToken(db, rawToken, input.authRoot, input.previousAuthRoot);
  }
  if (!match || !tokenUsable(match.token, input.nowMs)) return { kind: "unauthenticated" };

  const secretForHmac = match.token.format === "legacy" ? rawToken : presented.secret;
  if (match.viaPrevious) {
    try {
      await persistRotatedHmac(db, match.token.id, secretForHmac, input.authRoot);
    } catch {
      // Best-effort re-HMAC during auth-root rotation; auth still succeeds.
    }
  }

  const token = match.token;
  const user = await db.first<UserRow>("SELECT id, status FROM users WHERE id = ?", token.user_id);
  if (!user) return { kind: "unauthenticated" };
  if (user.status !== "active") return { kind: "forbidden" };

  const scopeRows = await db.all<{ scope: string }>(
    "SELECT scope FROM api_token_scopes WHERE token_id = ?",
    token.id,
  );

  try {
    return {
      kind: "ok",
      principal: createApiTokenPrincipal({
        tenantId: user.id,
        userId: user.id,
        tokenId: token.id,
        scopes: scopeRows.map((row) => row.scope),
      }),
    };
  } catch {
    return { kind: "unauthenticated" };
  }
}

function parseAuthorizationRaw(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

function tokenUsable(token: TokenRow, nowMs: number): boolean {
  return token.revoked_at_ms == null && token.expires_at_ms > nowMs;
}

interface TokenMatch {
  token: TokenRow;
  viaPrevious: boolean;
}

async function lookupLegacyToken(
  db: ControlPlaneDb,
  secret: string,
  authRoot: AuthRoot,
  previousAuthRoot?: AuthRoot,
): Promise<TokenMatch | null> {
  const active = await findLegacyByRoot(db, secret, authRoot);
  if (active) return { token: active, viaPrevious: false };
  if (!previousAuthRoot) return null;
  const previous = await findLegacyByRoot(db, secret, previousAuthRoot);
  return previous ? { token: previous, viaPrevious: true } : null;
}

async function findLegacyByRoot(
  db: ControlPlaneDb,
  secret: string,
  root: AuthRoot,
): Promise<TokenRow | null> {
  const digest = await hmacHex(await deriveHmacKey(root, "api_token"), secret);
  return db.first<TokenRow>(
    `SELECT id, user_id, format, secret_hmac, expires_at_ms, revoked_at_ms
     FROM api_tokens WHERE secret_hmac = ? AND format = 'legacy'`,
    digest,
  );
}

async function lookupStandardToken(
  db: ControlPlaneDb,
  selector: string,
  secret: string,
  authRoot: AuthRoot,
  previousAuthRoot?: AuthRoot,
): Promise<TokenMatch | null> {
  const row = await db.first<TokenRow>(
    `SELECT id, user_id, format, secret_hmac, expires_at_ms, revoked_at_ms
     FROM api_tokens WHERE id = ? AND format = 'standard'`,
    selector,
  );
  if (!row) return null;
  const activeDigest = await hmacHex(await deriveHmacKey(authRoot, "api_token"), secret);
  if (timingSafeEqualHex(activeDigest, row.secret_hmac)) {
    return { token: row, viaPrevious: false };
  }
  if (!previousAuthRoot) return null;
  const previousDigest = await hmacHex(await deriveHmacKey(previousAuthRoot, "api_token"), secret);
  return timingSafeEqualHex(previousDigest, row.secret_hmac)
    ? { token: row, viaPrevious: true }
    : null;
}

async function persistRotatedHmac(
  db: ControlPlaneDb,
  tokenId: string,
  secret: string,
  authRoot: AuthRoot,
): Promise<void> {
  const secretHmac = await hmacHex(await deriveHmacKey(authRoot, "api_token"), secret);
  await db.batch([
    {
      sql: "UPDATE api_tokens SET secret_hmac = ?, hash_key_version = ? WHERE id = ?",
      params: [secretHmac, authRoot.version, tokenId],
    },
  ]);
}

export async function revokeAllApiTokensForUser(
  db: ControlPlaneDb,
  input: { userId: string; nowMs: number },
): Promise<number> {
  const result = await db.run(
    `UPDATE api_tokens SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL`,
    input.nowMs,
    input.userId,
  );
  return result.changes;
}
