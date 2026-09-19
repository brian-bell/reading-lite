// Pure planning + merging for `corpus backfill-source-date`.
//
// Existing readings were written before HTML extract persisted `source_date`.
// Raw HTML is still in R2 under `raw.html`, so this re-runs the live
// `readabilityFromHtml` + `sourceDateFromPublishedTime` path over stored
// bytes: no refetch, no politeness budget, no dead-URL rewrite.
//
// The write adds exactly one field. Title, tags, summary, and `updated_at`
// stay byte-identical — this is not a reprocess. An existing `source_date`
// is never overwritten, even if stored HTML would now parse a different day.

import { readabilityFromHtml } from "../../src/modules/extractor";
import { sourceDateFromPublishedTime } from "../../src/modules/extractor/source-date";
import { ManifestSchema } from "../../src/schemas/manifest";

export type SourceDateCandidateClass = "already-dated" | "skip-markdown" | "inspect-html";

export type SourceDateInspectClass = "no-raw" | "unparseable" | "would-gain";

export function classifySourceDateCandidate(input: {
  source_date?: unknown;
  source_type?: unknown;
}): SourceDateCandidateClass {
  if (typeof input.source_date === "string" && input.source_date.trim() !== "") {
    return "already-dated";
  }
  if (input.source_type === "markdown") return "skip-markdown";
  return "inspect-html";
}

// Same date rules as live HTML extract: YYYY-MM-DD UTC, drop missing /
// unparseable / implausible / future. Salvaged raw-DOM fallbacks have no
// publishedTime, so they correctly yield no date.
export function sourceDateFromStoredHtml(
  html: string,
  url: string,
  nowMs: number,
): string | undefined {
  const article = readabilityFromHtml(html, url);
  if (!article) return undefined;
  return sourceDateFromPublishedTime(article.publishedTime, nowMs);
}

export function classifyStoredHtml(input: {
  rawHtml: string | null;
  url: string;
  nowMs: number;
}): { kind: SourceDateInspectClass; source_date?: string } {
  if (input.rawHtml === null) return { kind: "no-raw" };
  const source_date = sourceDateFromStoredHtml(input.rawHtml, input.url, input.nowMs);
  return source_date === undefined
    ? { kind: "unparseable" }
    : { kind: "would-gain", source_date };
}

export function withSourceDate<T extends object>(
  manifest: T,
  sourceDate: string,
): T & { source_date: string } {
  return { ...manifest, source_date: sourceDate };
}

export type ManifestCheck =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; error: string };

// Gate the object we are about to WRITE. Refuse an already-dated manifest so
// a caller cannot overwrite. Parse the candidate (not the input) so a
// malformed existing `source_date` is not a reason to skip a missing-date
// fill, and return the original merged object so ManifestSchema.strip() does
// not drop unknown stored fields.
export function validateSourceDateBackfillWrite(
  raw: unknown,
  sourceDate: string,
): ManifestCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const current = (raw as { source_date?: unknown }).source_date;
  if (typeof current === "string" && current.trim() !== "") {
    return { ok: false, error: "source_date already present" };
  }
  const candidate = withSourceDate(raw as Record<string, unknown>, sourceDate);
  const parsed = ManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "failed ManifestSchema",
    };
  }
  return { ok: true, manifest: candidate };
}
