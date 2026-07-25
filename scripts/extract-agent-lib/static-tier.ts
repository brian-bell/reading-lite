// Tier 1: the shared Worker extractor run locally, behind browser headers and
// the agent's SSRF-guarding fetch. Thin composition — all extraction logic
// stays in src/modules/extractor; this module only wires deps and maps thrown
// extractor errors to structured outcomes the orchestrator can act on.

import { extractFromUrl } from "../../src/modules/extractor";
import { makeBrowserFetch } from "../corpus-lib/browser-fetch";
import { mapExtractorError, type ExtractOutcome } from "./outcome";
import { safeFetch, type LookupFn } from "./safe-fetch";

export interface StaticTierDeps {
  fetch: typeof fetch;
  lookup: LookupFn;
  maxBytes: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function extractStatic(url: string, deps: StaticTierDeps): Promise<ExtractOutcome> {
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
      return {
        kind: "extracted",
        markdown: extracted.markdown,
        title: extracted.title,
        // Absent on non-HTML captures (text, JSON, YouTube): those came from no
        // Readability verdict at all, which is not a salvage and must not earn
        // a render.
        salvaged: extracted.salvaged === true,
        tier: "static",
      };
    }
    return { kind: "no_article", detail: `content_status ${extracted.content_status} — nothing extractable statically` };
  } catch (e) {
    return mapExtractorError(e);
  }
}
