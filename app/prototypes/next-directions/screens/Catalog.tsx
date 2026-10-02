/**
 * The catalog: the index of people, organizations, keywords, and hosts the
 * manifest already carries, with Find inside it. One field at the top takes a
 * word or, by meaning, a question; a term from the index, or a mention on a
 * reading, narrows to its readings. Results replace the index below the
 * field until cleared. Meaning search is simulated here; in production it
 * embeds the question with the reader's key and calls the existing
 * similarity endpoint.
 */
import { useState, type FormEvent } from "react";
import { Icon, useStudy } from "../context";
import { dateOn, hostOf, type Reading } from "../samples";
import { Go, PageHeading } from "../shared";
import { CATALOG_KINDS, catalogIndex, catalogTerms, matchesText, meaningSearch, newestFirst, parseFacet, reprocessFailed, type CatalogKind, type MeaningHit } from "../study";

export function CatalogPage() {
  const { route, go, items, provider } = useStudy();
  const kind = (CATALOG_KINDS.find((k) => k.kind === route.id)?.kind ?? "people") as CatalogKind;
  const label = CATALOG_KINDS.find((k) => k.kind === kind)!;
  const mode = route.mode === "meaning" ? "meaning" : "text";
  const [draft, setDraft] = useState(route.q);
  const facet = parseFacet(route.facet);
  const ready = items.filter((r) => r.status === "ready");
  const noKey = provider !== "connected";
  const entries = catalogIndex(ready, kind);
  function submit(event: FormEvent) {
    event.preventDefault();
    go("catalog", kind, { q: draft.trim(), mode });
  }
  let results: { reading: Reading; hit?: MeaningHit }[] | undefined;
  let heading = "";
  if (facet) {
    results = newestFirst(ready.filter((r) => catalogTerms(r, facet.kind).includes(facet.term))).map((reading) => ({ reading }));
    heading = `${results.length} reading${results.length === 1 ? "" : "s"} for ${facet.term}`;
  } else if (route.q && mode === "meaning") {
    results = meaningSearch(ready, route.q).map((hit) => ({ reading: hit.reading, hit }));
    heading = `${results.length} reading${results.length === 1 ? "" : "s"} close to “${route.q}”`;
  } else if (route.q) {
    results = newestFirst(ready.filter((r) => matchesText(r, route.q))).map((reading) => ({ reading }));
    heading = `${results.length} reading${results.length === 1 ? "" : "s"} matching “${route.q}”`;
  }
  const searching = results !== undefined;
  return (
    <div className="page catalog">
      <PageHeading aside={searching ? undefined : <span className="page-count">{entries.length} {entries.length === 1 ? label.singular : label.label.toLowerCase()}</span>}>Catalog</PageHeading>
      <form className="find-form" role="search" onSubmit={submit}>
        <div className="library-search-row">
          <label htmlFor="find-q" className="visually-hidden">Search</label>
          <input id="find-q" className="text-input" type="search" value={draft} placeholder={mode === "meaning" ? "Describe what you're looking for" : "A word, a name, a title"} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="button button-primary">Find</button>
        </div>
        <div className="find-modes">
          <div className="segmented" role="group" aria-label="Search by">
            <button type="button" aria-pressed={mode === "text"} onClick={() => go("catalog", kind, { q: route.q, mode: "text", facet: route.facet })}>Text</button>
            <button type="button" aria-pressed={mode === "meaning"} disabled={noKey} onClick={() => go("catalog", kind, { q: route.q, mode: "meaning", facet: route.facet })}>Meaning</button>
          </div>
          <p className="form-hint">{mode === "meaning" ? "Embeds your question with your key (a fraction of a cent) and compares it with your readings." : noKey ? "Text search is free. Meaning search needs your OpenAI key." : "Matches titles, summaries, and tags. Switch to Meaning to ask a question, or browse the index below."}</p>
        </div>
      </form>
      {searching ? (
        <section className="find-body" aria-live="polite">
          <p className="library-active-filters">
            {facet ? (
              <Go view="catalog" id={facet.kind} extra={{ q: route.q, mode }} className="tag tag-active" aria-label={`Clear ${facet.term}`}>{facet.term} <Icon name="close" size={12} strokeWidth={2} /></Go>
            ) : null}
            {route.q ? (
              <Go view="catalog" id={kind} extra={{ facet: route.facet, mode }} className="tag tag-active" aria-label={`Clear search ${route.q}`}>“{route.q}” <Icon name="close" size={12} strokeWidth={2} /></Go>
            ) : null}
            <Go view="catalog" id={kind} className="notice-link">Back to the index</Go>
          </p>
          <h2 className="section-title">{heading}</h2>
          {results!.length === 0 ? (
            <p className="library-message">Nothing close enough. {mode === "text" && !noKey && route.q ? <Go view="catalog" id={kind} extra={{ q: route.q, mode: "meaning" }}>Try by meaning</Go> : "Try other words, or a term from the index."}</p>
          ) : (
            <ul className="find-results" aria-label="Results">
              {results!.map(({ reading, hit }) => <ResultRow key={reading.id} reading={reading} hit={hit} />)}
            </ul>
          )}
        </section>
      ) : (
        <>
          <div className="tablist catalog-tabs" role="tablist" aria-label="Index">
            {CATALOG_KINDS.map((k) => <Go key={k.kind} view="catalog" id={k.kind} className="tab" aria-current={k.kind === kind ? "page" : undefined}>{k.label}</Go>)}
          </div>
          {entries.length === 0 ? (
            <p className="library-message">Nothing indexed yet. {label.label} come from each reading's summary once it is processed.</p>
          ) : (
            <ul className="catalog-entries" aria-label={label.label}>
              {entries.map((entry) => (
                <li key={entry.term} className="catalog-entry">
                  <Go view="catalog" id={kind} extra={{ facet: `${kind}:${entry.term}` }} className="catalog-term">{entry.term}</Go>
                  <span className="facet-count">{entry.count}</span>
                  <span className="catalog-entry-sample muted">{entry.readings[0].title}{entry.count > 1 ? ` and ${entry.count - 1} more` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** A compact row: the library's rows layout and the catalog's results. */
export function ResultRow({ reading, hit }: { reading: Reading; hit?: MeaningHit }) {
  return (
    <li className="find-row">
      <div className="find-row-main">
        <h3 className="find-row-title"><Go view="reading" id={reading.id}>{reading.title}</Go></h3>
        <p className="library-card-meta"><span>{hostOf(reading.url)}</span><span>Saved {dateOn(reading.createdAt)}</span>{reading.status !== "ready" ? <span>{reading.status === "pending" ? "Processing" : "Failed"}</span> : reprocessFailed(reading) ? <span>Reprocess failed</span> : null}</p>
        {reading.tldr ? <p className="find-row-lead">{reading.tldr}</p> : null}
      </div>
      {hit ? (
        <div className="find-row-why">
          <Closeness closeness={hit.closeness} />
          {hit.why.length ? <span className="form-hint">Matches {hit.why.slice(0, 3).join(", ")}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

function Closeness({ closeness }: { closeness: MeaningHit["closeness"] }) {
  return <span className={`closeness closeness-${closeness}`}>{closeness === "close" ? "Close" : closeness === "near" ? "Near" : "Faint"}</span>;
}

/** Under a reading's tags: its people, organizations, and keywords, each a way into the catalog. */
export function MentionsRow({ reading }: { reading: Reading }) {
  const mentions = [
    ...reading.people.map((term) => ({ kind: "people" as const, term })),
    ...reading.orgs.map((term) => ({ kind: "orgs" as const, term })),
    ...reading.keywords.map((term) => ({ kind: "keywords" as const, term })),
  ];
  if (mentions.length === 0) return null;
  return (
    <div className="mentions">
      <span className="mentions-label" aria-hidden="true">Mentions</span>
      <ul className="mentions-list" aria-label="Mentions">
        {mentions.map(({ kind, term }) => (
          <li key={`${kind}:${term}`}>
            <Go view="catalog" id={kind} extra={{ facet: `${kind}:${term}` }} className={`mention mention-${kind}`}>{term}</Go>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** After the relationship cards: readings close by similarity that no judge has connected yet. */
export function MoreLikeThis({ reading }: { reading: Reading }) {
  const { items, route } = useStudy();
  if (reading.status !== "ready") return null;
  const judged = new Set([reading.id, ...reading.connections.map((c) => c.id), ...reading.tensions.map((t) => t.id)]);
  const similar = meaningSearch(items, [reading.title, ...reading.keywords].join(" ")).filter((hit) => !judged.has(hit.reading.id)).slice(0, 3);
  if (similar.length === 0) return null;
  return (
    <section className="relationship-group" aria-label="More like this">
      <h3>More like this</h3>
      <p className="relationship-note">By similarity alone, not yet judged for a connection.</p>
      {similar.map((hit) => (
        <article key={hit.reading.id} className="relationship-card relationship-card-similar">
          <p className="relationship-kind"><Closeness closeness={hit.closeness} /></p>
          <p className="relationship-title"><Go view="reading" id={hit.reading.id} extra={{ trail: [...route.trail, reading.id] }}>{hit.reading.title}</Go></p>
          {hit.why.length ? <p className="relationship-reason">Shares {hit.why.slice(0, 3).join(", ")}.</p> : null}
        </article>
      ))}
    </section>
  );
}
