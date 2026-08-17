export type AuthKeyDomain = "session" | "api_token" | "magic_link" | "csrf" | "rate_limit";

export interface AuthRoot {
  secret: Uint8Array;
  version: number;
}

const HEX_256 = /^[0-9a-f]{64}$/i;
const HKDF_SALT = new TextEncoder().encode("reading-lite-auth-v1");

export function parseAuthRootSecret(raw: string): Uint8Array {
  const value = raw.trim();
  if (HEX_256.test(value)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  throw new Error("AUTH_ROOT_SECRET must be a 256-bit hex value");
}

export async function deriveHmacKey(root: AuthRoot, domain: AuthKeyDomain): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", root.secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new TextEncoder().encode(`reading-lite/v${root.version}/${domain}`),
    },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export async function hmacHex(key: CryptoKey, data: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(mac));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
