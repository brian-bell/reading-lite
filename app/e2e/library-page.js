// One page of the fixture pack's list index, as GET /api/readings answers it
// (the repo root's src/modules/stores/list-index.ts and src/router.ts):
// case-insensitive substring search over title, tldr, url, and keywords, an
// exact case-insensitive tag, newest first, 20 rows, and `has_more`.
//
// Shared by the stub entrypoint (server renders) and the browser route
// (e2e/test.ts), so both answer the same page. Staleness is not applied: the
// suite pins the browser to the pack's clock, at which no row is stale.
// Plain JavaScript because e2e/backend-stub.js runs as-is in workerd.

export const LIBRARY_PAGE_SIZE = 20;

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
