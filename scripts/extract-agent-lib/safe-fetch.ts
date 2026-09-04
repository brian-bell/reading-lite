// Re-export the Worker-owned SSRF fetch wrapper. Operator extract-agent and
// corpus recovery use the same per-hop scheme / DNS / IP / redirect / hop-cap
// rules as hosted extraction. Playwright stays operator-local; this module
// does not import it.

export {
  assertSafeDestination,
  DestinationResolutionError,
  resolveSafeDestination,
  safeFetch,
  TooManyRedirectsError,
  type LookupFn,
  type ResolvedAddress,
  type SafeFetchDeps,
} from "../../src/modules/extractor/safe-fetch";
