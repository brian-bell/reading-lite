import { resolve4, resolve6 } from "node:dns/promises";
import { DestinationResolutionError } from "./modules/extractor/safe-fetch";
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
// resolve. resolve4 + resolve6 are the implemented surface.
//
// The tolerated set is load-bearing — this runs on every hop of every reading,
// so mis-modeling it stops single-stack hosts resolving corpus-wide. Measured
// against the workerd this repo pins, ENOTFOUND is what comes back for a family
// with no records (`queryAaaa ENOTFOUND github.com`), for a name that does not
// exist, AND for a name whose nameservers answer SERVFAIL: `dnssec-failed.org`
// gets SERVFAIL from 1.1.1.1 at the wire level and ENOTFOUND here. workerd
// collapses all three onto one code, so this layer CANNOT tell a dead domain
// from a resolver fault. That is why an empty result is treated as possibly
// transient downstream (see DestinationResolutionError's handling): the cost of
// retrying a dead domain is a few attempts, the cost of not retrying a blip is
// a good reading permanently failed.
//
// A code outside that set therefore means something other than a DNS answer
// went wrong — the DoH request itself failed, say — and the family it covers
// went UNVETTED while `fetch` will still re-resolve and may connect over it. So
// it fails closed rather than proceeding on whichever family did answer.
//
// Be precise about what that does and does not buy, because the obvious
// stronger claim is wrong on this runtime. It does NOT stop an attacker whose
// nameserver faults one family: that fault arrives as ENOTFOUND, tolerated
// above, so the other family's addresses are still used and a private record on
// the unvetted family is still reachable. Closing THAT would mean treating a
// partial ENOTFOUND as unvetted, which is exactly what a single-stack host
// looks like — it would make every v4-only host unfetchable. The split-family
// gap is therefore not closeable at this layer while ENOTFOUND stays
// overloaded; it belongs with the DNS-rebinding residual safe-fetch.ts
// documents, and wants a resolver that reports rcodes distinctly.
//
// The error is wrapped rather than rethrown because the raw one is named
// "Error", which `retryableError` does not whitelist — an unwrapped throw would
// commit a terminal, non-retryable manifest for a fault that may well clear.
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
    if (hardError !== undefined) {
      throw new DestinationResolutionError(
        hostname,
        `destination resolver failed for ${hostname}`,
        { cause: hardError },
      );
    }
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
