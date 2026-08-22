// Canonical form for topical tags.
//
// Tags arrive from the summarizer as free text, so the same bucket shows up in
// several spellings: the live corpus holds `developer-tools` (99) alongside
// `developer tools` (32), and `software-engineering` (71) alongside
// `software engineering` (65) — 571 distinct tags across 468 readings. That
// splits the topical signal and, because `GET /api/readings` matches `q` and
// `?tag=` against this field, silently halves tag search results.
//
// Hyphen-joined lowercase is the canonical form: it is the majority spelling
// already (so fewer readings need rewriting) and it is unambiguous as a URL and
// query token, where a space has to be encoded and is easy to mismatch on.

// Characters kept as-is. Anything else is treated as a word separator, except
// that a tag made entirely of such characters is preserved rather than emptied.
const KEEP = /[a-z0-9]+/g;

export function normalizeTag(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (lowered === "") return "";
  const words = lowered.match(KEEP);
  if (words === null) return "";
  const joined = words.join("-");
  // A tag whose meaning lives in its punctuation ("c++", "f#") would be
  // mangled into a different, existing tag by stripping it. Keep the original
  // rather than silently merging two distinct topics.
  if (joined.length < lowered.replace(/[\s_/-]+/g, "").length) {
    return lowered.replace(/[\s_/]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }
  return joined;
}

// Normalizes a tag list, dropping empties and deduping tags that collapse onto
// the same canonical form. First-seen order is preserved so the summarizer's
// ordering (roughly most- to least-central) survives.
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n === "" || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
