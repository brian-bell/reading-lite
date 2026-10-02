/** The library: Connected's cards with what the combined direction adds to each, and a rows layout. */
import { useState } from "react";
import { Icon, useStudy } from "../context";
import { EmptyLibrary, FilterBar, Go, LibraryCard, NoveltyChip, PageHeading, useLibraryRows } from "../shared";
import { relationshipCount, threadFor, threadsOf } from "../study";
import { DeskToggle } from "./Desk";
import { ResultRow } from "./Catalog";

export function LibraryPage() {
  const rows = useLibraryRows();
  const { items } = useStudy();
  const threads = threadsOf(items);
  const [layout, setLayout] = useState<"cards" | "rows">("cards");
  return (
    <div className="page library">
      <PageHeading aside={
        <div className="page-head-tools">
          <span className="page-count">{items.length} reading{items.length === 1 ? "" : "s"}</span>
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>Cards</button>
            <button type="button" aria-pressed={layout === "rows"} onClick={() => setLayout("rows")}>Rows</button>
          </div>
        </div>
      }>Library</PageHeading>
      <FilterBar placeholder="Search titles and summaries, or ask the catalog by meaning" />
      {rows.length === 0 ? <EmptyLibrary /> : layout === "rows" ? (
        <ul className="find-results" aria-label="Readings">
          {rows.map((reading) => <ResultRow key={reading.id} reading={reading} />)}
        </ul>
      ) : (
        <ul className="library-list" aria-label="Readings">
          {rows.map((reading) => {
            const thread = threadFor(threads, reading.id);
            const count = relationshipCount(reading);
            return (
              <LibraryCard
                key={reading.id}
                reading={reading}
                extra={reading.status === "ready" ? (
                  <>
                    <p className="card-relations">
                      <NoveltyChip reading={reading} />
                      {count ? <span>{count}</span> : <span className="muted">No relationships yet</span>}
                      {thread ? <Go view="thread" id={thread.id} className="thread-link"><Icon name="thread" size={13} strokeWidth={2} /> {thread.name}</Go> : null}
                    </p>
                    <DeskToggle reading={reading} />
                  </>
                ) : undefined}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
