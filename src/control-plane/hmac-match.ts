import { deriveHmacKey, hmacHex, timingSafeEqualHex, type AuthKeyDomain, type AuthRoot } from "./crypto";

const DUMMY_HMAC = "0".repeat(64);

export interface HmacMatch {
  ok: true;
  viaPrevious: boolean;
}

export async function matchSecretHmac(
  secret: string,
  storedHmac: string | null,
  authRoot: AuthRoot,
  previousAuthRoot: AuthRoot | undefined,
  domain: AuthKeyDomain,
): Promise<HmacMatch | { ok: false }> {
  const stored = storedHmac ?? DUMMY_HMAC;
  const activeDigest = await hmacHex(await deriveHmacKey(authRoot, domain), secret);
  if (storedHmac && timingSafeEqualHex(activeDigest, stored)) {
    return { ok: true, viaPrevious: false };
  }
  if (previousAuthRoot) {
    const previousDigest = await hmacHex(await deriveHmacKey(previousAuthRoot, domain), secret);
    if (storedHmac && timingSafeEqualHex(previousDigest, stored)) {
      return { ok: true, viaPrevious: true };
    }
  } else if (!storedHmac) {
    timingSafeEqualHex(activeDigest, DUMMY_HMAC);
  }
  return { ok: false };
}
