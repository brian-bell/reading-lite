// The one extraction-outcome vocabulary both tiers speak, plus the extractor-
// error → outcome mapping they share.
//
// Tier 1 (static fetch) and tier 2 (headless render) fail in the same ways —
// they run the same extractor over the same error types — so the mapping lives
// here rather than being written twice with a slow drift between them. It also
// keeps the orchestrator honest: `run.ts` switches on one union and never has to
// know which tier produced the outcome except to report it.
//
// `tier` (which tier produced the markdown) and `salvaged` (which path inside
// the extractor produced it) are deliberately orthogonal: a headless render can
// still come out of the raw-DOM salvage, and the upgrade gates in later phases
// care about the second axis independently of the first.

import { BadStatusError, BlockedHostError } from "../../src/modules/extractor";
import { RateLimitedError } from "../../src/modules/http-retry";

export type ExtractOutcome =
  | { kind: "extracted"; markdown: string; title?: string; salvaged: boolean; tier: "static" | "headless" }
  | {
      kind: "challenge";
      detail: string;
      tier?: "static" | "headless";
      title?: string;
      normalizedChars?: number;
      evidence?: string[];
    }
  | { kind: "dead"; detail: string }
  | { kind: "no_article"; detail: string }
  | { kind: "error"; code: string; detail: string };

export function mapExtractorError(e: unknown): ExtractOutcome {
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
