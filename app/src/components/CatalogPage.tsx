import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import {
  KINDS,
  TERM_KINDS,
  catalogEmptyCopy,
  catalogListParams,
  catalogSearchOf,
  catalogViewOf,
  type CatalogIndex,
  type CatalogListView,
  type CatalogSearch,
  type CatalogView,
  type TermKind,
} from "../catalog";
import { catalogIndexQueryOptions } from "../catalog-query";
import { whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import { libraryQueryOptions } from "../library-query";
import { libraryViewOf, type LibraryView } from "../library-state";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { LibraryRows, useScrollRestoredOnceRowsArrive } from "./LibraryPage";
import { PAGE_LINK_ACTIVE, Pager } from "./Pager";
import { AccountChanged, Forbidden, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";
import { ViewTabs } from "./ViewTabs";

export function CatalogHome({ search }: { search: CatalogSearch }) {
  const { data: identity } = useQuery(whoamiQueryOptions());
  if (!identity) {
    return (
      <div className="page">
        <PageHeading>Catalog</PageHeading>
      </div>
    );
  }
  return <CatalogPage search={search} />;
}

function CatalogPage({ search }: { search: CatalogSearch }) {
  const view = catalogViewOf(search);
  if (view.mode === "index") return <CatalogIndex search={search} kind={view.kind} />;
  return <CatalogResults search={search} view={view} />;
}

function CatalogIndex({ search, kind }: { search: CatalogSearch; kind: TermKind }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(catalogIndexQueryOptions(queryClient, identity));
  const view = accountViewOf({ data, error, fetchStatus });
  const retry = () => void refetch();
  return (
    <PageStateFocus kind={view.kind}>
      {indexPage(view, retry, (index, notice) => (
        <div className="page catalog">
          <PageHeading>Catalog</PageHeading>
          <CatalogFind search={search} />
          {notice}
          {index ? <CatalogTabs kind={kind} index={index} /> : null}
        </div>
      ))}
    </PageStateFocus>
  );
}

function indexPage(
  view: AccountView<CatalogIndex>,
  onRetry: () => void,
  page: (index: CatalogIndex | undefined, notice: ReactNode) => ReactNode,
) {
  switch (view.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={onRetry} />;
    case "offline":
      return page(view.value, <OfflineNotice onRetry={onRetry} />);
    case "loading":
      return page(undefined, <LoadingRegion className="library-message" />);
    case "ready":
      return page(view.value, null);
  }
}

function CatalogTabs({ kind, index }: { kind: TermKind; index: CatalogIndex }) {
  const navigate = useNavigate();
  const entries = index[kind];
  return (
    <ViewTabs
      label="Index"
      idPrefix="catalog"
      tabs={TERM_KINDS.map((key) => ({ key, label: `${KINDS[key].label} ${index[key].length}` }))}
      selected={kind}
      onSelect={(next) => {
        void navigate({
          to: "/catalog",
          search: catalogSearchOf({ mode: "index", kind: next }),
          replace: true,
        });
      }}
    >
      {entries.length === 0 ? (
        <p className="auth-lede">No {kind} yet.</p>
      ) : (
        <ul className="catalog-entries" aria-label={KINDS[kind].label}>
          {entries.map((entry) => (
            <li key={entry.term} className="catalog-entry">
              <Link
                to="/catalog"
                search={catalogSearchOf({ mode: "term", facet: { kind, term: entry.term }, offset: 0 })}
                className="catalog-term"
              >
                {entry.term}
              </Link>
              <span className="catalog-count">{entry.count}</span>
            </li>
          ))}
        </ul>
      )}
    </ViewTabs>
  );
}

function CatalogResults({ search, view }: { search: CatalogSearch; view: CatalogListView }) {
  const params = catalogListParams(view);
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(libraryQueryOptions(queryClient, params, identity));
  const list = libraryViewOf({ data, error, fetchStatus });
  const retry = () => void refetch();
  return (
    <PageStateFocus kind={list.kind}>
      {resultsPage(list, view, search, retry)}
    </PageStateFocus>
  );
}

function resultsPage(list: LibraryView, view: CatalogListView, search: CatalogSearch, retry: () => void) {
  switch (list.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={list.actingTenant} />;
    case "server-error":
      return <ServerError message={list.message} onRetry={retry} />;
    default:
      return (
        <div className="page catalog">
          <PageHeading>Catalog</PageHeading>
          <CatalogFind search={search} />
          <CatalogList view={view} search={search} list={list} onRetry={retry} />
        </div>
      );
  }
}

function CatalogList({
  view,
  search,
  list,
  onRetry,
}: {
  view: CatalogListView;
  search: CatalogSearch;
  list: Extract<LibraryView, { kind: "loading" | "offline" | "ready" }>;
  onRetry: () => void;
}) {
  const page = list.kind === "loading" ? undefined : list.page;
  const empty = page !== undefined && page.readings.length === 0;
  useScrollRestoredOnceRowsArrive(list.kind === "loading", page !== undefined);
  return (
    <div className="catalog-results">
      <h2 className="catalog-heading">{view.mode === "term" ? view.facet.term : `Matching “${view.q}”`}</h2>
      {list.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {list.kind === "loading" ? <LoadingRegion className="library-message" /> : null}
      {page === undefined ? null : empty ? (
        <EmptyCatalog view={view} />
      ) : (
        <LibraryRows rows={page.readings} search={{}} />
      )}
      <Pager
        to="/catalog"
        search={search}
        offset={view.offset}
        hasMore={page === undefined ? list.kind === "loading" : page.has_more}
      />
    </div>
  );
}

function EmptyCatalog({ view }: { view: CatalogListView }) {
  return (
    <div className="library-message">
      <p className="auth-lede">{catalogEmptyCopy(view)}</p>
      <div className="form-actions">
        {view.q ? (
          <Link to="/catalog" search={catalogSearchOf(withoutQuery(view))} className="button" activeOptions={PAGE_LINK_ACTIVE}>
            Clear search
          </Link>
        ) : null}
        {view.mode === "term" ? (
          <Link to="/catalog" search={catalogSearchOf(withoutFacet(view))} className="button" activeOptions={PAGE_LINK_ACTIVE}>
            Clear {view.facet.term}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function CatalogFind({ search }: { search: CatalogSearch }) {
  const navigate = useNavigate();
  const view = catalogViewOf(search);
  const q = search.q?.trim() ? search.q : "";
  const [draft, setDraft] = useState(q);
  const [draftFor, setDraftFor] = useState(q);
  if (draftFor !== q) {
    setDraftFor(q);
    setDraft(q);
  }
  const facet = view.mode === "term" ? view.facet : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = viewForQuery(view, draft);
    setDraft(next.mode === "index" ? "" : (next.q ?? ""));
    void navigate({ to: "/catalog", search: catalogSearchOf(next) });
  };

  return (
    <form className="library-filters" role="search" aria-label="Find readings" onSubmit={submit}>
      <label className="field-label" htmlFor="catalog-find">
        Find
      </label>
      <div className="library-search-row">
        <input
          id="catalog-find"
          className="text-input"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Title, URL, summary, keywords"
          autoComplete="off"
        />
        <button type="submit" className="button">
          Find
        </button>
      </div>
      {q || facet ? (
        <p className="library-active-filters">
          <span>Filtered by</span>
          {facet ? (
            <Link
              to="/catalog"
              search={catalogSearchOf(withoutFacet(view))}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear ${facet.term}`}
            >
              {facet.term}
            </Link>
          ) : null}
          {q ? (
            <Link
              to="/catalog"
              search={catalogSearchOf(withoutQuery(view))}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear search “${q}”`}
            >
              “{q}”
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

function viewForQuery(current: CatalogView, draft: string): CatalogView {
  const q = draft.trim();
  if (current.mode === "term") {
    return q ? { mode: "term", facet: current.facet, q, offset: 0 } : { mode: "term", facet: current.facet, offset: 0 };
  }
  if (q === "") return { mode: "index", kind: current.kind };
  return { mode: "text", q, kind: current.kind, offset: 0 };
}

function withoutQuery(current: CatalogView): CatalogView {
  if (current.mode === "term") return { mode: "term", facet: current.facet, offset: 0 };
  if (current.mode === "text") return { mode: "index", kind: current.kind };
  return current;
}

function withoutFacet(current: CatalogView): CatalogView {
  if (current.mode !== "term") return current;
  if (current.q) return { mode: "text", q: current.q, kind: current.facet.kind, offset: 0 };
  return { mode: "index", kind: current.facet.kind };
}
