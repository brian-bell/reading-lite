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

// Markdown imports have no date in the article body. Submitters may prefix the
// markdown with a YAML front-matter block; the importer reads the first present
// of `source_date`, `published`, `date` (in that order) and normalizes it.
// Example:
//
//   ---
//   source_date: 2024-03-15
//   ---
//   # Title
//
// Missing, unparseable, and implausible values omit the field — they never
// fail the import. A present-but-bad preferred key does not fall through to
// a later one.
const MARKDOWN_FRONT_MATTER_KEYS = ["source_date", "published", "date"] as const;

export function sourceDateFromMarkdownFrontMatter(
  markdown: string,
  nowMs: number = Date.now(),
): string | undefined {
  const block = markdownFrontMatterBlock(markdown);
  if (block === undefined) return undefined;
  const raw = firstFrontMatterValue(block, MARKDOWN_FRONT_MATTER_KEYS);
  return sourceDateFromPublishedTime(raw, nowMs);
}

function markdownFrontMatterBlock(markdown: string): string | undefined {
  const text = markdown.replace(/^\uFEFF/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1];
}

function firstFrontMatterValue(
  block: string,
  keys: readonly string[],
): string | undefined {
  const found = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const value = unquoteYamlScalar(match[2]!);
    if (value.length === 0) continue;
    found.set(match[1]!.toLowerCase(), value);
  }
  for (const key of keys) {
    const value = found.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2) {
    const start = value[0];
    const end = value[value.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
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
