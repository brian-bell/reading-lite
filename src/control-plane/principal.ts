import { parseTenantId, parseTokenId, parseUserId, type TenantId, type UserId } from "./ids";

export const API_SCOPES = [
  "readings:read",
  "readings:write",
  "readings:import",
  "readings:delete",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export type AuthenticatedPrincipal =
  | {
      kind: "session";
      tenantId: TenantId;
      userId: UserId;
      sessionId: string;
      authenticatedAtMs: number;
    }
  | {
      kind: "api_token";
      tenantId: TenantId;
      userId: UserId;
      tokenId: string;
      scopes: ReadonlySet<ApiScope>;
    };

function assertV1Tenant(tenantId: TenantId, userId: UserId): void {
  if ((tenantId as string) !== (userId as string)) {
    throw new Error("v1 principal requires tenantId === userId");
  }
}

function parseScopes(scopes: Iterable<string>): ReadonlySet<ApiScope> {
  const parsed = new Set<ApiScope>();
  for (const scope of scopes) {
    if (!API_SCOPE_SET.has(scope)) {
      throw new Error(`unknown api scope: ${scope}`);
    }
    parsed.add(scope as ApiScope);
  }
  return parsed;
}

export function createApiTokenPrincipal(input: {
  tenantId: string;
  userId: string;
  tokenId: string;
  scopes: Iterable<string>;
}): Extract<AuthenticatedPrincipal, { kind: "api_token" }> {
  const tenantId = parseTenantId(input.tenantId);
  const userId = parseUserId(input.userId);
  const tokenId = parseTokenId(input.tokenId);
  if (!tenantId || !userId || !tokenId) {
    throw new Error("malformed principal identity");
  }
  assertV1Tenant(tenantId, userId);
  return {
    kind: "api_token",
    tenantId,
    userId,
    tokenId,
    scopes: parseScopes(input.scopes),
  };
}

export function principalHasScope(principal: AuthenticatedPrincipal, scope: ApiScope): boolean {
  if (principal.kind === "session") return true;
  return principal.scopes.has(scope);
}

export function createSessionPrincipal(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  authenticatedAtMs: number;
}): Extract<AuthenticatedPrincipal, { kind: "session" }> {
  const tenantId = parseTenantId(input.tenantId);
  const userId = parseUserId(input.userId);
  if (!tenantId || !userId) {
    throw new Error("malformed principal identity");
  }
  assertV1Tenant(tenantId, userId);
  return {
    kind: "session",
    tenantId,
    userId,
    sessionId: input.sessionId,
    authenticatedAtMs: input.authenticatedAtMs,
  };
}
