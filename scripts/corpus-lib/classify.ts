import type { ListItem, PendingClass } from "./types";

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/$/, "").slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// url -> set of every status seen for that url across the corpus. Lets us tell
// a genuinely-stranded pending from a stale duplicate of an already-ready url.
export function siblingStatuses(items: ListItem[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const it of items) {
    const s = m.get(it.url) ?? new Set<string>();
    s.add(it.status);
    m.set(it.url, s);
  }
  return m;
}

export interface Deduped<T> {
  rep: T;
  count: number;
}

// Collapse records sharing a url; representative is the newest by created_at.
export function dedupeByUrl<T extends { url: string; created_at: string }>(
  items: T[],
): Deduped<T>[] {
  const m = new Map<string, Deduped<T>>();
  for (const it of items) {
    const e = m.get(it.url);
    if (!e) m.set(it.url, { rep: it, count: 1 });
    else {
      e.count++;
      if (Date.parse(it.created_at) > Date.parse(e.rep.created_at)) e.rep = it;
    }
  }
  return [...m.values()];
}

// A url already carrying a ready reading is a cosmetic orphan-dup. Otherwise a
// pending is only "stranded" (a reprocess candidate) once it has outlived the
// pending TTL — within that window it may still be in-flight or backing off, so
// it's "fresh" and must not be force-reprocessed.
export function classifyPending(
  url: string,
  siblings: Map<string, Set<string>>,
  isStale: boolean,
): PendingClass {
  if (siblings.get(url)?.has("ready")) return "orphan-dup";
  return isStale ? "stranded" : "fresh";
}

export function isNewsletterHost(url: string): boolean {
  const h = hostOf(url);
  return h.includes("pragmaticengineer") || h.endsWith("substack.com") || h.includes("substack");
}

// A teaser is paywalled preview content. Size is the reliable signal (real
// articles run tens of KB); a strong cutoff marker rescues short-ish previews.
// Footer "subscribe now" CTAs in full articles are deliberately NOT enough.
const CUTOFF_MARKER = /this post is for (paid|free) subscribers|subscribe to keep reading|keep reading with a/i;

export function isTeaser(markdown: string): boolean {
  const len = markdown.length;
  if (len < 2500) return true;
  if (len < 8000 && CUTOFF_MARKER.test(markdown)) return true;
  return false;
}
