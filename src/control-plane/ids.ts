declare const tenantIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const tokenIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const challengeIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };
export type TokenId = string & { readonly [tokenIdBrand]: true };
export type SessionId = string & { readonly [sessionIdBrand]: true };
export type ChallengeId = string & { readonly [challengeIdBrand]: true };

// V1 invariant: the values are equal, while the types retain their meaning.
export interface TenantContext {
  tenantId: TenantId;
}

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const USER_ID_RE = new RegExp(`^usr_${UUID_V4}$`);
const TOKEN_ID_RE = new RegExp(`^tok_${UUID_V4}$`);
const SESSION_ID_RE = new RegExp(`^ses_${UUID_V4}$`);
const CHALLENGE_ID_RE = new RegExp(`^ml_${UUID_V4}$`);

export type UuidSource = () => string;

function canonicalize(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseUserId(raw: string): UserId | null {
  const value = canonicalize(raw);
  return USER_ID_RE.test(value) ? (value as UserId) : null;
}

export function parseTenantId(raw: string): TenantId | null {
  const userId = parseUserId(raw);
  return userId ? (userId as unknown as TenantId) : null;
}

export function parseTokenId(raw: string): TokenId | null {
  const value = canonicalize(raw);
  return TOKEN_ID_RE.test(value) ? (value as TokenId) : null;
}

export function parseSessionId(raw: string): SessionId | null {
  const value = canonicalize(raw);
  return SESSION_ID_RE.test(value) ? (value as SessionId) : null;
}

export function parseChallengeId(raw: string): ChallengeId | null {
  const value = canonicalize(raw);
  return CHALLENGE_ID_RE.test(value) ? (value as ChallengeId) : null;
}

export function mintUserId(uuid: UuidSource = () => crypto.randomUUID()): UserId {
  const parsed = parseUserId(`usr_${uuid()}`);
  if (!parsed) throw new Error("minted user id was malformed");
  return parsed;
}

export function mintTokenId(uuid: UuidSource = () => crypto.randomUUID()): TokenId {
  const parsed = parseTokenId(`tok_${uuid()}`);
  if (!parsed) throw new Error("minted token id was malformed");
  return parsed;
}

export function mintSessionId(uuid: UuidSource = () => crypto.randomUUID()): SessionId {
  const parsed = parseSessionId(`ses_${uuid()}`);
  if (!parsed) throw new Error("minted session id was malformed");
  return parsed;
}

export function mintChallengeId(uuid: UuidSource = () => crypto.randomUUID()): ChallengeId {
  const parsed = parseChallengeId(`ml_${uuid()}`);
  if (!parsed) throw new Error("minted challenge id was malformed");
  return parsed;
}
