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
  if (!createdAt) return undefined;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // A fixed locale, so the server render and the browser agree and hydration
  // does not swap the text under the reader.
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
  return `Saved ${formatted}`;
}

/** Only imported Markdown is called out; a fetched URL is the unremarkable case. */
export function sourceLabel(sourceType: string | undefined): string | undefined {
  return sourceType === "markdown" ? "Imported Markdown" : undefined;
}
