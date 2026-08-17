declare const tenantIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const tokenIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };
export type TokenId = string & { readonly [tokenIdBrand]: true };

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const USER_ID_RE = new RegExp(`^usr_${UUID_V4}$`);
const TOKEN_ID_RE = new RegExp(`^tok_${UUID_V4}$`);

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
