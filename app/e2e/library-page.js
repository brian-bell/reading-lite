// One page of the fixture pack's list index, as GET /api/readings answers it
// (the repo root's src/modules/stores/list-index.ts and src/router.ts):
// case-insensitive substring search over title, tldr, url, and keywords, an
// exact case-insensitive tag, newest first, 20 rows, and `has_more`.
//
// Shared by the stub entrypoint (server renders) and the browser route
// (e2e/test.ts), so both answer the same page. Both serve libraryItems: the
// pack's rows plus generated older ones, so the library has more than one
// page (#414) while the pack itself, and `seed:local`, keep their 19. Staleness is not applied: the
// suite pins the browser to the pack's clock, at which no row is stale.
// Plain JavaScript because e2e/backend-stub.js is bundled for workerd without
// the app's TypeScript config; the page size is the app's own constant.

import { LIBRARY_PAGE_SIZE } from "../src/library-search";

export { LIBRARY_PAGE_SIZE };

/** Generated rows past the pack's: with its 19, 43 rows over three pages. */
export const ARCHIVE_ROW_COUNT = 24;

/**
 * The pack's list rows followed by plain ready rows dated a day apart before
 * the pack's oldest, so every pack row stays first, in its own order, and the
 * generated ones fill pages two and three. Each row is shaped as the backend's
 * ListIndexItemSchema requires (test/unit/fixtures/app-fixture-pack.test.ts
 * at the repo root parses them), with the key prefix the layout would give it.
 */
export function libraryItems(items) {
  const oldest = Math.min(...items.map((item) => Date.parse(item.created_at)));
  const archive = Array.from({ length: ARCHIVE_ROW_COUNT }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    const id = `rd_FXARCHIV${n}`;
    const created_at = new Date(oldest - (index + 1) * 86_400_000).toISOString();
    const stamp = `${created_at.slice(0, 10).replaceAll("-", "/")}T${created_at.slice(11, 19).replaceAll(":", "")}Z`;
    return {
      id,
      key_prefix: `readings/${stamp}-${id}`,
      url: `https://archive.example/essays/${n}`,
      status: "ready",
      created_at,
      updated_at: created_at,
      title: `Archived essay ${n}`,
      tldr: "A generated row, so the library has a second and third page.",
      tags: [],
      keywords: [],
    };
  });
  return [...items, ...archive];
}

export function libraryPage(items, { q, tag, offset } = {}) {
  const query = (q ?? "").trim().toLowerCase();
  const wanted = (tag ?? "").trim().toLowerCase();
  const start = offset ?? 0;
  const filtered = items
    .filter((item) => {
      if (query !== "") {
        const hay = [item.title ?? "", item.tldr ?? "", item.url, ...(item.keywords ?? [])].join("\n").toLowerCase();
        if (!hay.includes(query)) return false;
      }
      if (wanted !== "" && !(item.tags ?? []).some((t) => t.toLowerCase() === wanted)) return false;
      return true;
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const readings = filtered.slice(start, start + LIBRARY_PAGE_SIZE);
  return {
    readings,
    limit: LIBRARY_PAGE_SIZE,
    offset: start,
    has_more: start + readings.length < filtered.length,
  };
}
