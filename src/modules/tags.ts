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

// A tag token: a run of letters or digits in ANY script, plus any trailing
// sigils that belong to the name -- the "++" of c++, the "#" of c# and f#.
// Everything else is a word boundary.
//
// This is the third shape, and the two it replaces are worth recording because
// they failed in opposite directions.
//
// The first enumerated what to keep (/[a-z0-9]+/), joined matches with hyphens,
// and used a length comparison to detect dropped characters. The inserted
// hyphens cancelled out the stripped characters in that comparison, so
// "f# music" became "f-music" and "c# developers" became "c-developers",
// silently merging a language tag into a different, plausible-looking one --
// the exact failure the guard existed to prevent. Trailing punctuation ("c++")
// was the only shape where the arithmetic happened to work, which is why one
// test case passed. Being ASCII-only, it also hyphenated inside accented words
// ("naïve" -> "na-ve").
//
// The second dropped the keep-list entirely and named only the separators. That
// fixed both bugs but accepted all punctuation as content, so "AI, ML" became
// "ai,-ml" while "AI ML" became "ai-ml" -- re-splitting the very variants this
// module exists to collapse -- and "!!!" survived as a tag.
//
// Matching tokens with an explicit sigil suffix needs neither a keep-list of
// languages nor arithmetic: \p{L} covers every script without a special case,
// and punctuation that is not an attached sigil falls out as a boundary.
// A token starts with a letter or digit in any script, continues through
// letters, digits and combining marks, and may end in sigils that belong to the
// name -- the "++" of c++, the "#" of c# and f#.
//
// \p{M} is load-bearing, not defensive: in Devanagari and many other scripts the
// vowel signs and virama are marks rather than letters, so a letters-only class
// shatters an ordinary word ("हिन्दी" -> "ह-न-द"). Marks may not START a token,
// which keeps a stray combining character from becoming a tag of its own.
//
// A sigil run is kept only when the WHOLE run ends the token, so it reads as
// the end of a name rather than as punctuation between two words: "c++" and
// "f# music" keep theirs, while "AI+ML" collapses to the same tag as "AI ML".
// The lookahead excludes further sigils as well as word characters, because
// `[+#]+` would otherwise backtrack to satisfy it and keep half a run --
// "C++17" became "c+-17", which is meaningless in either reading.
//
// Accepted limitation: that also means "C++17" normalizes to "c-17" rather
// than "c++17". There is no structural difference between "C++17" and "AI+ML"
// -- both are word, sigil run, word -- so no rule can keep one and split the
// other without a hardcoded list of language names. Collapsing variants is this
// module's purpose, so the tie goes to splitting. Nothing in the corpus
// currently has a tag containing "+" or "#" at all.
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[+#]+(?![+#\p{L}\p{N}]))?/gu;

export function normalizeTag(raw: string): string {
  // NFC first: a precomposed "naïve" and a decomposed "nai" + U+0308 are the
  // same tag to a reader, and a canonicalizer that leaves them as distinct
  // strings has not canonicalized them.
  const tokens = raw.normalize("NFC").toLowerCase().match(TOKEN);
  return tokens === null ? "" : tokens.join("-");
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
