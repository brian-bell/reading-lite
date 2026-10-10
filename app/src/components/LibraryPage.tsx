import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useElementScrollRestoration, useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type RefObject,
} from "react";
import { NetworkError } from "../api/errors";
import { needsProviderKey, whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import type { LibraryResult, LibraryRow } from "../library";
import { libraryBadge } from "../library-card";
import { libraryQueryOptions } from "../library-query";
import {
  LIBRARY_PAGE_SIZE,
  libraryEmptyCopy,
  libraryEmptyOf,
  libraryParamsOf,
  pageNumber,
  searchForFilters,
  searchForPage,
  type LibraryEmpty,
  type LibrarySearch,
} from "../library-search";
import { libraryReturnState } from "../library-return";
import { libraryViewOf, type LibraryView } from "../library-state";
import { isProcessing } from "../reading";
import { hostnameOf } from "../reading-presentation";
import { librarySchedule } from "../status-refresh";
import { ConnectKeyLink } from "./ConnectKey";
import { DeskToggle } from "./DeskToggle";
import { Icon } from "./Icon";
import { PageHeading, PageStateFocus, focusPageHeading } from "./PageHeading";
import { AccountChanged, Forbidden, InlineNotice, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";
import { SignInPage } from "./SignInPage";
import { useStatusWatch } from "./use-status-watch";

// The library (#413, first slice of #404). The page the URL names is read
// during the server render through the backend entrypoint, dehydrated into the
// page, and rendered here without a second request. Previous and Next (#414)
// are links to the neighbouring page's URL, so a page change is a client-side
// navigation that reads through same-origin /api/readings, and a reload or a
// deep link renders the same page on the server.
//
// The heading stays "Library" for everything the library itself has to say
// (rows, an empty library, a page past the end, loading, offline with nothing
// loaded), so focus after a route change lands on the same page whatever the
// rows turned out to be. The matrix's common states (#416) are the shared
// state pages, each with its own heading, as on the reading page: 403, 412,
// and a server error replace the library; a 401 is the shell's page; offline
// is a notice above whatever was already loaded.
//
// Search and tags (#417) are the URL's `q` and `tag`. The filter bar's form
// navigates to the search the draft names, a tag on a card is a link to the
// library filtered by it, and the active tag is a chip that links to the
// library without it; every one of these drops `offset` (searchForFilters).
// So a filter change is a client-side navigation like a page change, read
// through same-origin /api/readings, and a deep link or a reload renders the
// same filtered page on the server. An empty page names the search and tag
// it was filtered by, with the controls that clear them.
//
// A page with a reading being processed is refreshed every 15 s (#409; the
// status refresh contract's Library rule), in the terms of use-status-watch.ts:
// the watch belongs to the page's query, so another page or filter starts
// again, and it ends once no row on the page is active. A row that finishes
// changes its badge in place, with nothing announced and focus left alone. A
// failed check leaves the rows on screen; after three, a quiet note says the
// page stopped checking, until another page, filter, or a reload starts a new
// watch. It has no button: a manual check would not restart the refresh.

/** `/`: the sign-in form in place when signed out, the library when signed in. */
export function LibraryHome({ search }: { search: LibrarySearch }) {
  const { data: identity } = useQuery(whoamiQueryOptions());
  // The form renders here rather than at /login, so it has to carry this URL
  // itself: without it the library's filters are lost on return, and the
  // request wipes a path stored earlier in this tab (#384 review).
  const href = useLocation({ select: (location) => location.href });
  if (identity === null) return <SignInPage next={href} landing />;
  // Identity could not be determined: the shell shows neither account state,
  // and there is no account to read a library for.
  if (identity === undefined) {
    return (
      <div className="page">
        <PageHeading>Library</PageHeading>
      </div>
    );
  }
  return <LibraryPage search={search} />;
}

export function LibraryPage({ search }: { search: LibrarySearch }) {
  const params = libraryParamsOf(search);
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const watch = useStatusWatch<LibraryResult>({ keyOf: libraryWatchKeyOf, schedule: librarySchedule });
  const { data, error, fetchStatus, refetch } = useQuery(
    libraryQueryOptions(queryClient, params, identity, watch.options),
  );
  // An error while the page is checking itself, or after it stopped for
  // failures, is a failed check, which keeps the rows. Any other keeps its own
  // state: offline at once, and a failed read with no check to blame (none
  // watching, or past the cap, as after a save) is the server error.
  const checkFailed =
    (watch.status === "watching" || watch.status === "failures") && !(error instanceof NetworkError && error.offline);
  const view = libraryViewOf({ data, error: checkFailed ? null : error, fetchStatus });
  const stoppedChecking = watch.status === "failures" && error !== null;
  const retry = () => void refetch();
  // A read that settles as a different page replaces the one on screen, and
  // whatever had focus in it; PageStateFocus hands the new heading that focus.
  // The filter change last asked for, and where focus goes once it lands
  // (see FilterFocus). Owned here, above the controls that set it and the bar
  // that consumes it, and dropped with the page.
  const pendingFilterFocus = useRef<FilterFocus | undefined>(undefined);

  return (
    <PendingFilterFocus.Provider value={pendingFilterFocus}>
      <PageStateFocus kind={view.kind}>{pageFor(view, search, params.offset, retry, stoppedChecking)}</PageStateFocus>
    </PendingFilterFocus.Provider>
  );
}

/** What the library's status watch follows: the page's query, while any row on it is active. */
function libraryWatchKeyOf(data: LibraryResult | undefined, queryHash: string): string | null {
  if (data?.state !== "ready" || !data.page.readings.some(isProcessing)) return null;
  return queryHash;
}

function pageFor(
  view: LibraryView,
  search: LibrarySearch,
  offset: number,
  retry: () => void,
  stoppedChecking: boolean,
) {
  switch (view.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={retry} />;
    default:
      return (
        <div className="page library">
          <PageHeading>Library</PageHeading>
          <LibraryFilters search={search} />
          <LibraryContent
            view={view}
            search={search}
            offset={offset}
            onRetry={retry}
            stoppedChecking={stoppedChecking}
          />
        </div>
      );
  }
}

/**
 * What sits under the Library heading: the busy region, the offline notice,
 * or the rows, and the pager. The pager stays mounted while a page is being
 * read, with Next kept as it was: a page change from the keyboard leaves
 * focus on the step that was pressed, and only a step that turns out to be
 * unavailable on arrival loses its href and hands focus to the page number
 * (see Pager). A page with no rows has no pager; if the step that led there
 * still had focus, the heading takes it (see Pager), since unmounting a
 * focused element drops focus to the top of the document without a blur.
 */
function LibraryContent({
  view,
  search,
  offset,
  onRetry,
  stoppedChecking,
}: {
  view: Extract<LibraryView, { kind: "loading" | "offline" | "ready" }>;
  search: LibrarySearch;
  offset: number;
  onRetry: () => void;
  stoppedChecking: boolean;
}) {
  const page = view.kind === "loading" ? undefined : view.page;
  const empty = page !== undefined && page.readings.length === 0;
  useScrollRestoredOnceRowsArrive(view.kind === "loading", page !== undefined);
  return (
    <>
      {view.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {view.kind === "ready" && stoppedChecking ? <InlineNotice message="Couldn't check status." live={false} /> : null}
      {view.kind === "loading" ? (
        <LoadingRegion className="library-message" />
      ) : page === undefined ? null : empty ? (
        <EmptyLibrary empty={libraryEmptyOf(libraryParamsOf(search))} search={search} />
      ) : (
        <LibraryRows rows={page.readings} search={search} />
      )}
      {empty ? null : (
        <Pager search={search} offset={offset} hasMore={page === undefined ? view.kind === "loading" : page.has_more} />
      )}
    </>
  );
}

/**
 * Scroll restoration runs when the route renders. A page whose rows were
 * already cached (#407: kept 30 minutes) is whole by then, but one read again
 * on return — browser Back or "Back to library" after the cache let it go —
 * renders its loading state first, so the saved position is clamped to that
 * short page and never tried again. Once rows replace a loading state, this
 * applies the position saved for this history entry, if there is one. A new
 * navigation's entry has none and stays at the top.
 */
function useScrollRestoredOnceRowsArrive(loading: boolean, loaded: boolean): void {
  const saved = useElementScrollRestoration({ getElement: () => (typeof window === "undefined" ? undefined : window) });
  const waited = useRef(false);
  useLayoutEffect(() => {
    if (loading) {
      waited.current = true;
      return;
    }
    if (!loaded || !waited.current) return;
    waited.current = false;
    if (saved) window.scrollTo({ left: saved.scrollX, top: saved.scrollY });
  }, [loading, loaded, saved]);
}

function LibraryRows({ rows, search }: { rows: readonly LibraryRow[]; search: LibrarySearch }) {
  return (
    <ul className="library-list" aria-label="Readings">
      {rows.map((row) => (
        <LibraryCard key={row.id} row={row} search={search} />
      ))}
    </ul>
  );
}

// Where focus goes once a filter change has rendered. The library stays
// mounted through a filter change (the router keys a route's component only
// by remountDeps, which are not set), but the control that was used does
// not: a chip or an empty page's link is gone once its filter is cleared, a
// tag on a card goes with the rows while the new page is read, and losing the
// focused element drops focus to the top of the document. The control says
// where focus should land instead: the search field after a search or a
// clear, the tag's chip after a tag is chosen, so the filter now applied is
// what is announced.
//
// The request records the filters it navigates to, and the bar acts on it
// only when those are the filters that arrive, then forgets it either way. A
// change that never lands as a filter change (the same search submitted
// again, a modified click that opened a new tab, a read that settled as a
// state page) is not carried over to some later navigation.
interface FilterFocus {
  target: "search" | "tag";
  q: string | undefined;
  tag: string | undefined;
}

const PendingFilterFocus = createContext<RefObject<FilterFocus | undefined> | null>(null);

/** Records where focus goes once the library shows `next`'s filters. */
function useFocusAfterFilterChange(): (target: FilterFocus["target"], next: LibrarySearch) => void {
  const pending = useContext(PendingFilterFocus);
  return (target, next) => {
    if (pending) pending.current = { target, q: next.q, tag: next.tag };
  };
}

/**
 * The filter bar (design spec, Components; #417): the search draft, submitted
 * as `q` trimmed and removed when empty as the legacy SPA does, and the
 * active filters as chips, each a link to the library without it. The draft
 * follows the URL, so a cleared or deep-linked search shows in the field. The
 * chips are named for what they clear, and differently from the empty page's
 * Clear search and Clear tag, so the two never read as one control repeated.
 */
function LibraryFilters({ search }: { search: LibrarySearch }) {
  const navigate = useNavigate();
  const q = search.q ?? "";
  const tag = search.tag;
  // The bar outlives a filter change, so the draft is reset from the URL
  // when `q` changes under it: a cleared or deep-linked search shows in the
  // field, and a search submitted from another page does not linger.
  const [draft, setDraft] = useState(q);
  const [draftFor, setDraftFor] = useState(q);
  if (draftFor !== q) {
    setDraftFor(q);
    setDraft(q);
  }
  const field = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLAnchorElement>(null);
  const pending = useContext(PendingFilterFocus);
  const focusAfterFilterChange = useFocusAfterFilterChange();
  useEffect(() => {
    const asked = pending?.current;
    if (!asked || !pending) return;
    pending.current = undefined;
    if ((asked.q ?? "") !== q || asked.tag !== tag) return;
    (asked.target === "tag" ? chip.current : field.current)?.focus();
  }, [pending, q, tag]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = searchForFilters(search, { q: draft.trim() });
    // The field shows what was searched for, even when the URL does not change.
    setDraft(next.q ?? "");
    focusAfterFilterChange("search", next);
    void navigate({ to: "/", search: next });
  };

  return (
    <form className="library-filters" role="search" aria-label="Filter readings" onSubmit={submit}>
      <label className="field-label" htmlFor="library-search">
        Search
      </label>
      <div className="library-search-row">
        <input
          ref={field}
          id="library-search"
          className="text-input"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Title, URL, summary, keywords"
          autoComplete="off"
        />
        <button type="submit" className="button">
          Search
        </button>
      </div>
      {q || tag ? (
        <p className="library-active-filters">
          <span>Filtered by</span>
          {q ? (
            <Link
              to="/"
              search={searchForFilters(search, { q: undefined })}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear search “${q}”`}
              onClick={() => focusAfterFilterChange("search", searchForFilters(search, { q: undefined }))}
            >
              “{q}”
              <Icon name="close" size={10} strokeWidth={3} />
            </Link>
          ) : null}
          {tag ? (
            <Link
              ref={chip}
              to="/"
              search={searchForFilters(search, { tag: undefined })}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear tag ${tag}`}
              onClick={() => focusAfterFilterChange("search", searchForFilters(search, { tag: undefined }))}
            >
              {tag}
              <Icon name="close" size={10} strokeWidth={3} />
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

/** An empty page's Clear search or Clear tag: the library without that filter, and focus back in the field. */
function ClearFilter({ search, filter }: { search: LibrarySearch; filter: "q" | "tag" }) {
  const focusAfterFilterChange = useFocusAfterFilterChange();
  const next = searchForFilters(search, { [filter]: undefined });
  return (
    <Link
      to="/"
      search={next}
      activeOptions={PAGE_LINK_ACTIVE}
      className="button"
      onClick={() => focusAfterFilterChange("search", next)}
    >
      {filter === "q" ? "Clear search" : "Clear tag"}
    </Link>
  );
}

/**
 * A page with no rows (acceptance matrix, Library states): an empty library
 * offers to save a reading; no results name the search and tag with the
 * controls that clear them; a page past the end names its number, with the
 * first page and the same clear controls.
 */
function EmptyLibrary({ empty, search }: { empty: LibraryEmpty; search: LibrarySearch }) {
  const { data: identity } = useQuery({ ...whoamiQueryOptions(), enabled: false });
  // A new reader with no key yet (reading-lite-gh341.11): a save would be
  // refused, so the way on is connecting one, with the samples to look at
  // meanwhile.
  if (empty.kind === "no-readings" && needsProviderKey(identity)) {
    return (
      <div className="library-message">
        <p className="auth-lede">{NO_READINGS_NO_KEY}</p>
        <div className="form-actions">
          <ConnectKeyLink primary />
          <Link to="/samples" className="button">
            Browse samples
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="library-message">
      <p className="auth-lede">{libraryEmptyCopy(empty)}</p>
      <div className="form-actions">
        {empty.kind === "no-readings" ? (
          <Link to="/save" className="button">
            Save a reading
          </Link>
        ) : null}
        {empty.kind === "past-end" ? (
          <Link to="/" search={searchForPage(search, 0)} activeOptions={PAGE_LINK_ACTIVE} className="button">
            First page
          </Link>
        ) : null}
        {empty.kind !== "no-readings" && empty.q ? <ClearFilter search={search} filter="q" /> : null}
        {empty.kind !== "no-readings" && empty.tag ? <ClearFilter search={search} filter="tag" /> : null}
      </div>
    </div>
  );
}

const NO_READINGS_NO_KEY = "No readings yet. Connect your OpenAI key, then save your first reading.";

// Another page's link is never the current page. By default the router counts
// `/` as active on every page of the library, since no search is a subset of
// any, and marks Previous with aria-current.
const PAGE_LINK_ACTIVE = { exact: true, includeSearch: true } as const;

/**
 * Previous, the page number, and Next. The page number follows the snapped
 * offset asked for, and Next `hasMore`: the backend's `has_more`, or, while
 * the page is still being read, assumed, so a reader stepping forward keeps
 * the control they are on. Offline with nothing loaded, nothing is assumed.
 * A step that cannot be followed stays in place, disabled, so the pager
 * never shifts.
 *
 * The step a reader just followed is usually the one that becomes unavailable
 * on arrival: Next into the last page, Previous back to the first. Losing its
 * href makes the browser blur it, and their next Tab would start again at the
 * top of the document, so the page number takes the focus, naming the page
 * they landed on and leaving Tab where they were. Only that blur: focus
 * leaving for somewhere else carries a relatedTarget, and a step a reader can
 * still follow is not disabled.
 *
 * When the page that arrives has no rows at all, the pager goes with them.
 * If the step that led there still had focus, the heading takes it as the
 * pager unmounts, for the same reason: the layout cleanup runs while the step
 * is still in the document to ask.
 */
function Pager({ search, offset, hasMore }: { search: LibrarySearch; offset: number; hasMore: boolean }) {
  const nav = useRef<HTMLElement>(null);
  const pageLabel = useRef<HTMLSpanElement>(null);
  const keepFocusInPager = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget === null && event.target.getAttribute("aria-disabled") === "true") {
      pageLabel.current?.focus();
    }
  };
  useLayoutEffect(
    () => () => {
      if (nav.current?.contains(document.activeElement)) focusPageHeading();
    },
    [],
  );

  return (
    <nav className="library-pager" aria-label="Pagination" onBlur={keepFocusInPager} ref={nav}>
      <PagerStep label="Previous" search={offset > 0 ? searchForPage(search, offset - LIBRARY_PAGE_SIZE) : null} />
      <span className="library-pager-page" ref={pageLabel} tabIndex={-1}>
        Page {pageNumber(offset)}
      </span>
      <PagerStep label="Next" search={hasMore ? searchForPage(search, offset + LIBRARY_PAGE_SIZE) : null} />
    </nav>
  );
}

/**
 * One step: a link while there is a page that way, and the same element
 * disabled when there isn't. Not preloaded: after a click, the pointer and
 * focus stay on Next, whose href then names the following page, and a
 * loading state's shorter pager can slide that control back under the
 * cursor. That pass is not intent to read the neighbour, same as a pointer
 * or Tab crossing a page of tag links.
 */
function PagerStep({ label, search }: { label: string; search: LibrarySearch | null }) {
  return (
    <Link
      to="/"
      // A disabled link has no href, so the search is only read for a step
      // that can be followed.
      search={search ?? {}}
      disabled={search === null}
      activeOptions={PAGE_LINK_ACTIVE}
      preload={false}
      className="button library-pager-step"
    >
      {label}
    </Link>
  );
}

/** A tag as the backend compares it (src/modules/stores/list-index.ts): trimmed, case-insensitive. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * One card: the state badge when the reading is not simply ready (#415), the
 * title, the summary lead clamped at three lines (the stylesheet's job), the
 * hostname, and the tags (#417). The title link is stretched over the whole
 * card, so the card is one target without nesting anything inside a link;
 * the badge and the failure's headline are plain text, so they add nothing
 * the pointer or the keyboard could land on instead. The tags are the one
 * exception: each is its own link to the library filtered by it, raised
 * above the stretched link (the stylesheet's job) and a tab stop of its own,
 * and not preloaded, since a pointer or Tab passing over a page of them is
 * not intent to read every one. The tag the library is already filtered by
 * is plain text, so no card claims to be the current page; it is matched as
 * the backend matches it, trimmed and case-insensitive, so `?tag=Design` and
 * `?tag=%20design%20` mark the same rows. They are inline
 * links rather than a list, so the card stays the one list item the page's
 * list counts. The desk toggle, on a ready card or one already on the desk,
 * is raised above the stretched link the same way.
 * A reading with no title yet (pending, failed) is named by its URL. Long
 * titles wrap and are never truncated.
 */
function LibraryCard({ row, search }: { row: LibraryRow; search: LibrarySearch }) {
  const badge = libraryBadge(row);
  const focusAfterFilterChange = useFocusAfterFilterChange();
  const activeTag = search.tag === undefined ? undefined : normalizeTag(search.tag);
  return (
    <li className="library-card">
      {badge ? (
        <p className="library-card-status">
          <span className={`status-badge status-badge-${badge.kind}`}>{badge.label}</span>
          {badge.kind === "failed" ? <span className="library-card-error">{badge.message}</span> : null}
        </p>
      ) : null}
      <h2 className="library-card-title">
        {/* Records this library entry, so the reading's "Back to library" returns here, scrolled as it was (#407). */}
        <Link to="/readings/$id" params={{ id: row.id }} state={libraryReturnState}>
          {row.title ?? row.url}
        </Link>
      </h2>
      {row.tldr ? <p className="library-card-summary">{row.tldr}</p> : null}
      <p className="library-card-meta">{hostnameOf(row.url)}</p>
      {row.tags && row.tags.length > 0 ? (
        <p className="library-card-tags">
          {row.tags.map((tag) =>
            normalizeTag(tag) === activeTag ? (
              <span key={tag} className="tag tag-current">
                {tag}
              </span>
            ) : (
              <Link
                key={tag}
                to="/"
                search={searchForFilters(search, { tag })}
                activeOptions={PAGE_LINK_ACTIVE}
                preload={false}
                className="tag"
                onClick={() => focusAfterFilterChange("tag", searchForFilters(search, { tag }))}
              >
                {tag}
              </Link>
            ),
          )}
        </p>
      ) : null}
      {row.status === "ready" || row.desk_position !== undefined ? (
        <DeskToggle reading={row} className="library-card-desk" />
      ) : null}
    </li>
  );
}
