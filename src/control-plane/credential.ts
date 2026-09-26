// Opaque `<selector>.<256-bit secret>` credentials. The database stores only an HMAC of
// the secret; the public selector is the row primary key.

const SECRET_BYTES = 32;

export interface PresentedCredential<TSelector extends string> {
  selector: TSelector;
  secret: string;
}

export type RandomBytes = (byteLength: number) => Uint8Array;

export function mintSecretHex(randomBytes: RandomBytes = defaultRandomBytes): string {
  return bytesToHex(randomBytes(SECRET_BYTES));
}

export function formatCredential(selector: string, secretHex: string): string {
  return `${selector}.${secretHex}`;
}

export function parseCredential<TSelector extends string>(
  raw: string,
  parseSelector: (value: string) => TSelector | null,
): PresentedCredential<TSelector> | null {
  const value = raw.trim();
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const selector = parseSelector(value.slice(0, dot));
  const secret = value.slice(dot + 1);
  if (!selector || !secret) return null;
  return { selector, secret };
}

export function defaultRandomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
