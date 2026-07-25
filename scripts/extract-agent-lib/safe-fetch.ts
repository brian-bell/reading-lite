// LAN-SSRF-guarding fetch wrapper for ALL agent egress. The Worker's
// assertSafeUrl checks only the initial URL, and on Cloudflare that was enough
// because the platform blocks private-IP egress; the home box has no such
// backstop, so this wrapper:
//   - forces redirect: "manual" (regardless of caller init — makeBrowserFetch
//     hardcodes "follow") and follows hops itself, re-running the blocked-host
//     rules on every Location;
//   - resolves non-literal hostnames via the injected lookup and rejects when
//     any resolved address is private/loopback/link-local, before connecting;
//   - caps the redirect chain at maxHops (default 5).
//
// Accepted residual risk (documented, deliberate): DNS-rebinding TOCTOU. We
// check resolved addresses and then let the base fetch re-resolve; a hostile
// nameserver could answer differently between check and connect. Closing that
// gap needs a custom undici connect hook pinned to the checked address, which
// is not worth v1 complexity — URLs reach the agent only via the authed API
// (self-submitted), so the attacker would be the operator.

import { assertSafeUrl, BlockedHostError, isBlockedHost } from "../../src/modules/extractor";

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export class TooManyRedirectsError extends Error {
  constructor(public readonly url: string, public readonly maxHops: number) {
    super(`redirect chain exceeded ${maxHops} hops: ${url}`);
    this.name = "TooManyRedirectsError";
  }
}

export interface SafeFetchDeps {
  lookup: LookupFn;
  maxHops?: number;
}

const DEFAULT_MAX_HOPS = 5;

// GET-only semantics: the agent never POSTs through this wrapper, so hops are
// re-issued with the caller's init unchanged (no 303 method rewriting).
export function safeFetch(base: typeof fetch, deps: SafeFetchDeps): typeof fetch {
  const maxHops = deps.maxHops ?? DEFAULT_MAX_HOPS;
  return async (input, init = {}) => {
    let url = urlOf(input);
    for (let redirects = 0; ; redirects++) {
      await assertSafeDestination(url, deps.lookup);
      const response = await base(url, { ...init, redirect: "manual" });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return response;
      if (redirects >= maxHops) throw new TooManyRedirectsError(url, maxHops);
      response.body?.cancel().catch(() => {});
      url = new URL(location, url).href;
    }
  };
}

async function assertSafeDestination(url: string, lookup: LookupFn): Promise<void> {
  assertSafeUrl(url); // scheme + literal/hostname rules, shared with the Worker
  const hostname = new URL(url).hostname.toLowerCase();
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(bare)) return; // already vetted by assertSafeUrl; nothing to resolve
  const addresses = await lookup(bare);
  for (const { address } of addresses) {
    if (isBlockedHost(address.toLowerCase())) {
      throw new BlockedHostError(url, `resolves to private/loopback/link-local address: ${address}`);
    }
  }
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
