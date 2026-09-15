import type { ReactNode } from "react";

// A link that leaves for a third-party page, from a summary or a captured
// source (design spec, Source content): a new tab, and no referrer, opener,
// or endorsement. Given the page's own URL as `base`, a site-relative href
// from a captured article resolves against the article's site rather than
// this app's host. The sanitizer has already dropped unsafe schemes, so what
// arrives here is http(s), mailto and the like, or relative.

export function ExternalLink({ href, base, children }: { href?: string; base?: string; children?: ReactNode }) {
  return (
    <a href={resolveHref(href, base)} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

export function resolveHref(href: string | undefined, base: string | undefined): string | undefined {
  if (!href || !base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
