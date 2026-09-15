import type { EnrichmentDegradation, Reading } from "./reading";

// Text derived from a reading by fixed rules (design spec, Data mapping). The
// production UI renders only real data, or text derived from it this way —
// there is no author line and no reading time, because the backend produces
// neither.

/**
 * The hostname stands in for the author and publication the prototype showed.
 * A URL the backend stored but this browser cannot parse still has to render,
 * so it falls back to the raw string rather than blanking the line.
 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** `created_at` → "Saved 7 September 2026". Omitted when the manifest has no date. */
export function savedOn(createdAt: string | undefined): string | undefined {
  const formatted = dateOn(createdAt);
  return formatted ? `Saved ${formatted}` : undefined;
}

/**
 * An ISO timestamp → "7 September 2026", or nothing for a missing or unparseable
 * one. A fixed locale and zone, so the server render and the browser agree and
 * hydration does not swap the text under the reader.
 */
export function dateOn(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * An ISO timestamp → "7 September 2026, 09:30 UTC", for the Details section's
 * attempts and events (#373), where the time of day is the point. Same fixed
 * locale and zone as `dateOn`, for the same hydration reason.
 */
export function dateTimeOn(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(parsed);
  return `${formatted.replace(" at ", ", ")} UTC`;
}

/** Only imported Markdown is called out; a fetched URL is the unremarkable case. */
export function sourceLabel(sourceType: string | undefined): string | undefined {
  return sourceType === "markdown" ? "Imported Markdown" : undefined;
}

/**
 * The novelty panel's label and sentence (design spec, Novelty).
 *
 * The sentences are fixed: the summarizer writes a verdict, not an
 * explanation, and adding one would change its schema and need a paid
 * reprocess to backfill. So the panel states what the verdict means and
 * nothing more — the similarity numbers behind it belong in Details (#373).
 *
 * Returns nothing rather than a placeholder when there is no verdict to
 * report. Manifests written before novelty existed have none (fixture
 * `old-manifest`), and the spec is explicit that "unclassified" never appears.
 */
export interface NoveltyPanel {
  label: string;
  sentence: string;
  /** "Familiar" links to the connections when there are some to see (#371). */
  linksToConnections: boolean;
}

const VERDICTS: Record<string, Omit<NoveltyPanel, "linksToConnections">> = {
  novel: { label: "Novel", sentence: "Nothing already in your library covers this closely." },
  familiar: { label: "Familiar", sentence: "Overlaps with readings already in your library." },
  duplicate: { label: "Duplicate", sentence: "Effectively the same piece as one already in your library." },
};

/** Sparse archive: the library itself had nothing to compare against. */
const SPARSE_SENTENCE = "Your library had no close readings when this was processed.";

export function noveltyPanel(reading: Reading): NoveltyPanel | undefined {
  // Novelty is judged while a reading is summarized, so it describes a reading
  // that has been. A pending or failed one has nothing to report yet.
  if (reading.status !== "ready") return undefined;
  const verdict = reading.novelty_verdict === undefined ? undefined : VERDICTS[reading.novelty_verdict];
  if (!verdict) return undefined;
  // A missing count is not a count of zero: an older manifest that never
  // recorded one must not be described as having faced an empty library.
  if (reading.similarity?.count === 0) {
    return { label: verdict.label, sentence: SPARSE_SENTENCE, linksToConnections: false };
  }
  // Connections, not tensions: the link names what it goes to, and a reading
  // whose only relationships are tensions has no Connections group to reach.
  const linksToConnections = reading.novelty_verdict === "familiar" && (reading.connections?.length ?? 0) > 0;
  return { ...verdict, linksToConnections };
}

/**
 * The muted notice on a YouTube reading that became ready on the oEmbed floor
 * (acceptance matrix, Degraded YouTube). It names what was missing, because
 * "some enrichment failed" tells a reader nothing about why the summary is
 * thin.
 *
 * The watch page carries both the description and the caption list
 * (src/modules/extractor/index.ts), so losing it loses the transcript too;
 * losing only the transcript keeps the description. A tier with no sentence
 * here stays quiet rather than naming nothing — a new one arrives with the
 * backend change that writes it.
 */
const DEGRADATION_NOTICES: Record<string, string> = {
  watch_page:
    "This video's description and transcript couldn't be read, so the summary is based on its title and channel alone.",
  transcript:
    "This video's transcript couldn't be read, so the summary is based on its title, channel, and description.",
};

export function degradationNotice(degradation: EnrichmentDegradation | undefined): string | undefined {
  if (!degradation?.tier) return undefined;
  return DEGRADATION_NOTICES[degradation.tier];
}

/**
 * `summary_markdown` with a first paragraph that only repeats the lead removed.
 *
 * The spec puts `tldr` in the serif lead and `summary_markdown` below it, and
 * the summarizer is asked for a tldr that captures the thesis and a summary
 * that opens with the argument — so in practice the summary's first paragraph
 * is often the tldr verbatim (every ready fixture in the pack is). Printing
 * both leaves the reader reading the same sentence twice.
 *
 * Only an exact match is dropped. A paragraph that merely covers the same
 * ground is the summarizer's own writing and stays.
 */
export function summaryBodyBelowLead(
  tldr: string | undefined,
  summaryMarkdown: string | undefined,
): string | undefined {
  const body = summaryMarkdown?.trim();
  if (!body) return undefined;
  if (!tldr) return body;
  const [first, ...rest] = body.split(/\n\s*\n/);
  if (first?.trim() !== tldr.trim()) return body;
  const remainder = rest.join("\n\n").trim();
  return remainder === "" ? undefined : remainder;
}
