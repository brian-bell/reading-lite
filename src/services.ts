export interface Services {
  fetch: typeof fetch;
  now: () => string;
  newId: () => string;
}

export function defaultServices(): Services {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function mintReadingId(): string {
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) {
    s += ID_ALPHABET[b % ID_ALPHABET.length];
  }
  return `rd_${s}`;
}

export function parseReadingId(raw: string): string | null {
  if (!raw.startsWith("rd_")) return null;
  const suffix = raw.slice(3);
  return suffix.length === 10 && [...suffix].every((character) => ID_ALPHABET.includes(character))
    ? raw
    : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
