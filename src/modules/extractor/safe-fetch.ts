// Per-hop SSRF guard for every extractor egress hop (HTML, YouTube, X, and
// the operator extract-agent). Cloudflare private-egress blocking is not the
// contract — this wrapper is. LookupFn is injected so this module never
// imports `node:dns` (Workers-pool tests load the extractor).
//
// Per hop: approved http(s) scheme, no userinfo, literal + resolved DNS
// addresses checked against private/loopback/link-local/multicast (and
// NAT64/6to4 embedded private v4), redirect: "manual" with hop cap 5,
// credentials stripped on cross-origin hops.
//
// Accepted residual (documented, deliberate): DNS-rebinding TOCTOU. We check
// resolved addresses and then let the base fetch re-resolve; a hostile
// nameserver could answer differently between check and connect. Workers
// fetch cannot pin the checked IP.

import { BlockedHostError } from "./errors";

export interface ResolvedAddress {
  address: string;
  family?: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export class TooManyRedirectsError extends Error {
  constructor(
    public readonly url: string,
    public readonly maxHops: number,
  ) {
    super(`redirect chain exceeded ${maxHops} hops: ${url}`);
    this.name = "TooManyRedirectsError";
  }
}

export class DestinationResolutionError extends Error {
  constructor(
    public readonly url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DestinationResolutionError";
  }
}

export interface SafeFetchDeps {
  lookup: LookupFn;
  maxHops?: number;
  // Optional redirect-target policy, applied to each resolved Location before
  // the hop is vetted and fetched; default identity. Lets a route re-apply its
  // required request shape (the Reddit route's `.json?raw_json=1`) when a
  // redirector drops it. The rewritten URL goes through the same per-hop
  // destination check as any other — a hook can narrow, never widen.
  rewriteRedirect?: (target: string) => string;
}

const DEFAULT_MAX_HOPS = 5;

// WHATWG fetch's redirect status set — deliberately not "any 3xx". A 304 also
// carries a Location and would otherwise be swapped for a different resource;
// that is reachable here because conditional-GET headers are forwarded. 300
// and 305 are likewise not redirects to follow.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// GET-only semantics: hops are re-issued with the caller's metadata unchanged
// (no 303 method rewriting) and no request body is forwarded. The caller's
// `input` may be a Request; its headers/method/signal are merged with `init`
// (init wins) so an authenticated or conditional GET is not silently stripped
// — though credential headers are dropped once the chain leaves the original
// origin, mirroring native fetch.
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
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (!location) return response;
      response.body?.cancel().catch(() => {});
      if (redirects >= maxHops) throw new TooManyRedirectsError(url, maxHops);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        // TypeError here is an attacker-controlled Location, not a transport
        // failure. fetchWithRetry would otherwise retry the first hop.
        throw new BlockedHostError(url, "invalid redirect location");
      }
      // Native fetch drops credentials when a redirect leaves the origin;
      // issuing hops ourselves opts out of that, so re-apply it by hand. The
      // strip is permanent for the rest of the chain — a hop back to the
      // original origin must not resurrect what an off-origin hop already saw.
      if (next.origin !== new URL(url).origin) stripCredentials(headers);
      url = deps.rewriteRedirect?.(next.href) ?? next.href;
    }
  };
}

// Per WHATWG fetch's HTTP-redirect step for a cross-origin Location.
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
  "www-authenticate",
];

function stripCredentials(headers: Headers): void {
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
}

// Exported for the headless tier and its validating proxy so browser and fetch
// egress apply one hostname/resolved-address policy.
export async function assertSafeDestination(
  url: string,
  lookup: LookupFn,
  signal?: AbortSignal,
): Promise<void> {
  await resolveSafeDestination(url, lookup, signal);
}

export async function resolveSafeDestination(
  url: string,
  lookup: LookupFn,
  signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
  throwIfAborted(signal);
  assertSafeUrl(url); // scheme + userinfo + literal/hostname rules
  const hostname = new URL(url).hostname.toLowerCase();
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(bare)) return [{ address: bare }]; // already vetted by assertSafeUrl; nothing to resolve
  const addresses = await abortable(lookup(bare), signal);
  if (addresses.length === 0) {
    throw new DestinationResolutionError(url, `destination resolved to no addresses: ${url}`);
  }
  for (const { address } of addresses) {
    if (isBlockedHost(address.toLowerCase())) {
      throw new BlockedHostError(url, `resolves to private/loopback/link-local address: ${address}`);
    }
  }
  return addresses;
}

// LookupFn takes no signal (node's dns.promises.lookup has none), so a stalled
// resolver would otherwise outlive the extraction timeout. Racing against the
// request signal bounds it; the abandoned lookup settles into the void.
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

export function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedHostError(rawUrl, "invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedHostError(rawUrl, `non-http(s) scheme: ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BlockedHostError(rawUrl, "userinfo is not allowed");
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (isBlockedHost(host)) {
    throw new BlockedHostError(rawUrl, `private/loopback/link-local: ${host}`);
  }
}

// Takes a normalized hostname: lowercased, IPv6 brackets stripped.
export function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host === "localhost.") return true;
  if (host.endsWith(".local") || host.endsWith(".local.")) return true;

  if (isBlockedV4(host)) return true;

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    // IPv4-mapped, IPv4-compatible, 6to4, and NAT64 decode to the embedded
    // IPv4; re-run the v4 rules against that address.
    const embedded = embeddedIPv4(host);
    if (embedded && isBlockedV4(embedded)) return true;
    const head = host.split(":")[0] ?? "";
    if (head.startsWith("fc") || head.startsWith("fd")) return true;
    // fe80::/10 link-local (fe80–febf) and fec0::/10 site-local (fec0–feff).
    // Site-local is deprecated but some home LANs still route it.
    if (/^fe[89a-f][0-9a-f]{0,2}$/.test(head)) return true;
    // ff00::/8 multicast (and the reserved ffx0 span above it).
    if (head.startsWith("ff")) return true;
  }
  return false;
}

function isBlockedV4(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Shared address space (RFC 6598). Tailscale and CGNAT both live here, so a
  // redirect into 100.64/10 reaches overlay/internal services exactly like
  // RFC1918 would — no public source is ever hosted on it.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && Number(v4[3]) === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC 2544)
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

function embeddedIPv4(host: string): string | null {
  // host is bracket-stripped, lowercased. WHATWG URL canonicalizes
  // "[::ffff:127.0.0.1]" to "[::ffff:7f00:1]" so we need to expand "::" and
  // decode the trailing 32 bits. The dotted spelling never reaches us from a
  // parsed URL, but DNS-resolved addresses (per-hop lookup checks) do use it
  // — normalize it to the hex form first.
  const dotted = host.match(/^(.+):(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const quad = dotted[2]!.split(".").map(Number);
    if (quad.some((n) => n > 255)) return null;
    host = `${dotted[1]}:${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
  }
  let segments: string[];
  if (host.includes("::")) {
    const [left, right] = host.split("::", 2) as [string, string];
    const leftParts = left === "" ? [] : left.split(":");
    const rightParts = right === "" ? [] : right.split(":");
    const fill = 8 - leftParts.length - rightParts.length;
    if (fill < 0) return null;
    segments = [...leftParts, ...Array<string>(fill).fill("0"), ...rightParts];
  } else {
    segments = host.split(":");
  }
  if (segments.length !== 8) return null;

  const mapped = mappedOrCompatibleV4(segments);
  if (mapped) return mapped;

  // 6to4 2002:AABB:CCDD::/48 embeds A.B.C.D in the next 32 bits.
  if (segments[0] === "2002") {
    return hextetsToV4(segments[1]!, segments[2]!);
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds IPv4 in the last 32 bits.
  if (
    segments[0] === "64" &&
    segments[1] === "ff9b" &&
    segments[2] === "0" &&
    segments[3] === "0" &&
    segments[4] === "0" &&
    segments[5] === "0"
  ) {
    return hextetsToV4(segments[6]!, segments[7]!);
  }

  return null;
}

function mappedOrCompatibleV4(segments: string[]): string | null {
  for (let i = 0; i < 5; i++) {
    if (segments[i] !== "0") return null;
  }
  if (segments[5] !== "0" && segments[5] !== "ffff") return null;
  return hextetsToV4(segments[6]!, segments[7]!);
}

function hextetsToV4(hiHextet: string, loHextet: string): string | null {
  const hi = parseInt(hiHextet, 16);
  const lo = parseInt(loHextet, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
