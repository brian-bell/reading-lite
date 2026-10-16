import {
  GetReadingTermsResponseSchema,
  TERM_KINDS,
  type GetReadingTermsResponse,
  type TermKind,
} from "../../src/schemas/api";

export interface CatalogReading {
  id: string;
  url: string;
  status: string;
  people?: readonly string[];
  orgs?: readonly string[];
  keywords?: readonly string[];
}

function byCodePoint(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  for (;;) {
    const a = leftPoints.next();
    const b = rightPoints.next();
    if (a.done && b.done) return 0;
    if (a.done) return -1;
    if (b.done) return 1;
    const aPoint = a.value.codePointAt(0)!;
    const bPoint = b.value.codePointAt(0)!;
    if (aPoint !== bPoint) return aPoint < bPoint ? -1 : 1;
  }
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function termsOf(reading: CatalogReading, kind: TermKind): readonly string[] {
  if (kind === "hosts") {
    const host = hostOf(reading.url);
    return host === undefined ? [] : [host];
  }
  return reading[kind] ?? [];
}

export function catalogIndexOf(manifests: readonly CatalogReading[]): GetReadingTermsResponse {
  const index: Record<TermKind, { term: string; count: number }[]> = {
    people: [],
    orgs: [],
    keywords: [],
    hosts: [],
  };
  for (const kind of TERM_KINDS) {
    const foldedIds = new Map<string, Set<string>>();
    const spellings = new Map<string, Map<string, Set<string>>>();
    for (const manifest of manifests) {
      if (manifest.status !== "ready") continue;
      const seen = new Set<string>();
      for (const raw of termsOf(manifest, kind)) {
        const term = raw.trim();
        if (term === "") continue;
        const folded = term.toLowerCase();
        if (!seen.has(folded)) {
          seen.add(folded);
          const ids = foldedIds.get(folded) ?? new Set<string>();
          ids.add(manifest.id);
          foldedIds.set(folded, ids);
        }
        const byTerm = spellings.get(folded) ?? new Map<string, Set<string>>();
        const termIds = byTerm.get(term) ?? new Set<string>();
        termIds.add(manifest.id);
        byTerm.set(term, termIds);
        spellings.set(folded, byTerm);
      }
    }
    const rows = [...foldedIds.entries()].map(([folded, ids]) => {
      const choices = [...(spellings.get(folded)?.entries() ?? [])];
      choices.sort((a, b) => b[1].size - a[1].size || byCodePoint(a[0], b[0]));
      return { folded, term: choices[0]![0], count: ids.size };
    });
    rows.sort((a, b) => byCodePoint(a.folded, b.folded));
    index[kind] = rows.map(({ term, count }) => ({ term, count }));
  }
  return GetReadingTermsResponseSchema.parse(index);
}
