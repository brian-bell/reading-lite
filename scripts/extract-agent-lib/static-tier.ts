// Tier 1: the shared Worker extractor run locally, behind browser headers and
// the agent's SSRF-guarding fetch. Thin composition — all extraction logic
// stays in src/modules/extractor; this module only wires deps and maps thrown
// extractor errors to structured outcomes the orchestrator can act on.

import {
  BadStatusError,
  BlockedHostError,
  extractFromUrl,
} from "../../src/modules/extractor";
import { RateLimitedError } from "../../src/modules/http-retry";
import { makeBrowserFetch } from "../corpus-lib/browser-fetch";
import { safeFetch, type LookupFn } from "./safe-fetch";

export type StaticOutcome =
  | { kind: "extracted"; markdown: string; title?: string; extractor: "readability" }
  | { kind: "challenge"; detail: string }
  | { kind: "dead"; detail: string }
  | { kind: "no_article"; detail: string }
  | { kind: "error"; code: string; detail: string };

export interface StaticTierDeps {
  fetch: typeof fetch;
  lookup: LookupFn;
  maxBytes: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function extractStatic(url: string, deps: StaticTierDeps): Promise<StaticOutcome> {
  // makeBrowserFetch hardcodes redirect: "follow"; safeFetch owns redirect
  // handling regardless of caller init (override, don't trust) — so the
  // wrapping order matters: browser headers outside, safety innermost.
  const guardedFetch = makeBrowserFetch(safeFetch(deps.fetch, { lookup: deps.lookup }));
  try {
    const extracted = await extractFromUrl(url, {
      fetch: guardedFetch,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: deps.maxBytes,
    });
    if (extracted.content_status === "captured" && extracted.markdown && extracted.markdown.trim().length > 0) {
      return { kind: "extracted", markdown: extracted.markdown, title: extracted.title, extractor: "readability" };
    }
    return { kind: "no_article", detail: `content_status ${extracted.content_status} — nothing extractable statically` };
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): StaticOutcome {
  // A 429 comes out of the extractor as RateLimitedError (fetchBounded converts
  // it before the BadStatusError check) — treat it like a 403 challenge.
  if (e instanceof RateLimitedError) return { kind: "challenge", detail: e.message };
  if (e instanceof BadStatusError) {
    if (e.status === 403) return { kind: "challenge", detail: e.message };
    if (e.status === 404 || e.status === 410) return { kind: "dead", detail: e.message };
    return { kind: "error", code: "BadStatusError", detail: e.message };
  }
  if (e instanceof BlockedHostError) return { kind: "error", code: "BlockedHostError", detail: e.message };
  if (e instanceof Error) return { kind: "error", code: e.name, detail: e.message };
  return { kind: "error", code: "UnknownError", detail: String(e) };
}
