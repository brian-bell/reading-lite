import { resolve4, resolve6 } from "node:dns/promises";
import type { LookupFn, ResolvedAddress } from "./modules/extractor/safe-fetch";

export interface Services {
  fetch: typeof fetch;
  // Injected DNS lookup for extractor SSRF checks. Tests inject fakes.
  // The extractor module never imports node:dns.
  lookup: LookupFn;
  now: () => string;
  newId: () => string;
}

export interface DnsResolvers {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
}

// Cloudflare's node:dns is DoH to 1.1.1.1 and throws on lookup / lookupService /
// resolve. resolve4 + resolve6 are the implemented surface. NODATA on one
// family is normal for single-stack names, and workerd reports it as ENOTFOUND,
// so that whole set is tolerated as "this family has no records".
//
// Any other failure means a family went UNVETTED while `fetch` will still
// re-resolve and may connect over it — so it fails closed even when the other
// family answered. Returning the survivors would let an attacker whose
// nameserver fails A queries hide a private A record behind a public AAAA
// answer, which is a deterministic bypass, not the DNS-rebinding race
// safe-fetch.ts documents as an accepted residual. The thrown error is an
// ordinary transport failure, so fetchWithRetry still retries it.
export function lookupFromResolvers(resolvers: DnsResolvers): LookupFn {
  return async (hostname) => {
    const [v4, v6] = await Promise.allSettled([
      resolvers.resolve4(hostname),
      resolvers.resolve6(hostname),
    ]);
    const addresses: ResolvedAddress[] = [];
    let hardError: unknown;
    if (v4.status === "fulfilled") {
      for (const address of v4.value) addresses.push({ address, family: 4 });
    } else if (!isNoDataError(v4.reason)) {
      hardError = v4.reason;
    }
    if (v6.status === "fulfilled") {
      for (const address of v6.value) addresses.push({ address, family: 6 });
    } else if (!isNoDataError(v6.reason)) {
      hardError = v6.reason;
    }
    if (hardError !== undefined) throw hardError;
    return addresses;
  };
}

export const nodeDnsLookup: LookupFn = lookupFromResolvers({
  resolve4: (hostname) => resolve4(hostname),
  resolve6: (hostname) => resolve6(hostname),
});

export function defaultServices(): Services {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    lookup: nodeDnsLookup,
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

function isNoDataError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT";
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
