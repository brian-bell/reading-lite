// Normalize a Readability (or similar) published-time string into the
// Manifest `source_date` shape: UTC calendar date `YYYY-MM-DD`. Missing,
// unparseable, and implausible values are dropped rather than stored.
//
// Ready-draft wiring (processReading, sidecarTargetFor, recover activation):
// a fresh extract is authoritative; the prior fills in only when the extract
// has no date. The recover pending must persist that result so an
// activating-window crash can reuse extracted.md without a `fresh` object.

/** Inclusive lower bound. Dates before this are treated as parser garbage. */
export const SOURCE_DATE_MIN = "1900-01-01";

/** Fresh extract wins; the prior fills the gap. Absence of both omits the field. */
export function sourceDateFromExtractOrPrior(
  fresh: string | undefined,
  prior: string | undefined,
): string | undefined {
  return fresh ?? prior;
}

export function sourceDateFromPublishedTime(
  publishedTime: string | null | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (typeof publishedTime !== "string") return undefined;
  const trimmed = publishedTime.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;

  const date = new Date(parsed).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (date > today) return undefined;
  if (date < SOURCE_DATE_MIN) return undefined;
  return date;
}
