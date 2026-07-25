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
// re-issued with the caller's metadata unchanged (no 303 method rewriting) and
// no request body is forwarded. The caller's `input` may be a Request; its
// headers/method/signal are merged with `init` (init wins) so an authenticated
// or conditional GET is not silently stripped — though credential headers are
// dropped once the chain leaves the original origin, mirroring native fetch.
export function safeFetch(base: typeof fetch, deps: SafeFetchDeps): typeof fetch {
  const maxHops = deps.maxHops ?? DEFAULT_MAX_HOPS;
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const signal = request.signal;
    const headers = new Headers(request.headers);
    let url = request.url;
    for (let redirects = 0; ; redirects++) {
      await assertSafeDestination(url, deps.lookup, signal);
      // Every hop carries the caller's signal so the extraction timeout still
      // aborts the in-flight fetch, and the DNS step above races against it
      // too. Headers are copied per hop so a later strip cannot retroactively
      // mutate what an earlier hop was handed.
      const response = await base(url, {
        method: request.method,
        headers: new Headers(headers),
        signal,
        redirect: "manual",
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return response;
      response.body?.cancel().catch(() => {});
      if (redirects >= maxHops) throw new TooManyRedirectsError(url, maxHops);
      const next = new URL(location, url);
      // Native fetch drops credentials when a redirect leaves the origin;
      // issuing hops ourselves opts out of that, so re-apply it by hand. The
      // strip is permanent for the rest of the chain — a hop back to the
      // original origin must not resurrect what an off-origin hop already saw.
      if (next.origin !== new URL(url).origin) stripCredentials(headers);
      url = next.href;
    }
  };
}

// Per WHATWG fetch's HTTP-redirect step for a cross-origin Location.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "cookie2", "proxy-authorization", "www-authenticate"];

function stripCredentials(headers: Headers): void {
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
}

async function assertSafeDestination(url: string, lookup: LookupFn, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  assertSafeUrl(url); // scheme + literal/hostname rules, shared with the Worker
  const hostname = new URL(url).hostname.toLowerCase();
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(bare)) return; // already vetted by assertSafeUrl; nothing to resolve
  const addresses = await abortable(lookup(bare), signal);
  for (const { address } of addresses) {
    if (isBlockedHost(address.toLowerCase())) {
      throw new BlockedHostError(url, `resolves to private/loopback/link-local address: ${address}`);
    }
  }
}

// LookupFn takes no signal (node's dns.promises.lookup has none), so a stalled
// resolver would otherwise outlive the extraction timeout and, because the
// agent works one row at a time, wedge the whole unattended run. Racing against
// the request signal bounds it; the abandoned lookup settles into the void.
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
