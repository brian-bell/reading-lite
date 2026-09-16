import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type FocusEvent, type RefObject } from "react";
import { whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import type { LibraryPage as LibraryPageBody, LibraryRow } from "../library";
import { libraryBadge } from "../library-card";
import { libraryQueryOptions } from "../library-query";
import {
  LIBRARY_PAGE_SIZE,
  libraryParamsOf,
  pageNumber,
  searchForPage,
  type LibrarySearch,
} from "../library-search";
import { libraryViewOf, type LibraryView } from "../library-state";
import { hostnameOf } from "../reading-presentation";
import { PageHeading, focusPageHeading } from "./PageHeading";
import { AccountChanged, Forbidden, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";
import { SignInPage } from "./SignInPage";

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
// is a notice above whatever was already loaded. Tags and filters are later
// slices of #404.

/** `/`: the sign-in form in place when signed out, the library when signed in. */
export function LibraryHome({ search }: { search: LibrarySearch }) {
  const { data: identity } = useQuery(whoamiQueryOptions());
  // The form renders here rather than at /login, so it has to carry this URL
  // itself: without it the library's filters are lost on return, and the
  // request wipes a path stored earlier in this tab (#384 review).
  const href = useLocation({ select: (location) => location.href });
  if (identity === null) return <SignInPage next={href} />;
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

const subscribeOnline = (listener: () => void) => onlineManager.subscribe(listener);
const isOnline = () => onlineManager.isOnline();
const isOnlineOnServer = () => true;

export function LibraryPage({ search }: { search: LibrarySearch }) {
  const params = libraryParamsOf(search);
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, isPending, fetchStatus, refetch } = useQuery(libraryQueryOptions(queryClient, params, identity));
  // Re-rendered when the browser's connection comes and goes, so the offline
  // notice follows it. TanStack Query listens to the same events to pause and
  // continue the fetch.
  const online = useSyncExternalStore(subscribeOnline, isOnline, isOnlineOnServer);
  const view = libraryViewOf({ data, error, isPending, fetchStatus, online });
  const retry = () => void refetch();
  // A read that settles as one of the state pages replaces the library, and
  // whatever had focus in it: the heading a route change just focused, or the
  // pager step the reader pressed. The new page's heading takes it, so the
  // state is announced rather than focus falling to the top of the document.
  const focusWasInLibrary = useRef(false);
  useEffect(() => {
    if (focusWasInLibrary.current) {
      focusWasInLibrary.current = false;
      focusPageHeading();
    }
  }, [view.kind]);

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
          <FocusWithin flag={focusWasInLibrary} />
          <PageHeading>Library</PageHeading>
          <LibraryContent view={view} search={search} offset={params.offset} onRetry={retry} />
        </div>
      );
  }
}

/**
 * Records, as the library is unmounted, whether focus was inside it. Layout
 * cleanup runs before the DOM is removed, so the focused element is still
 * there to ask.
 */
function FocusWithin({ flag }: { flag: RefObject<boolean> }) {
  useLayoutEffect(
    () => () => {
      flag.current = document.activeElement?.closest(".page.library") !== null;
    },
    [flag],
  );
  return null;
}

/**
 * What sits under the Library heading: the busy region, the offline notice,
 * or the rows, and the pager. The pager stays mounted while a page is being
 * read, with Next kept as it was: a page change from the keyboard leaves
 * focus on the step that was pressed, and only a step that turns out to be
 * unavailable on arrival loses its href and hands focus to the page number
 * (see Pager). Unmounting it would drop focus to the top of the document
 * without a blur.
 */
function LibraryContent({
  view,
  search,
  offset,
  onRetry,
}: {
  view: Extract<LibraryView, { kind: "loading" | "offline" | "ready" }>;
  search: LibrarySearch;
  offset: number;
  onRetry: () => void;
}) {
  const page = view.kind === "loading" ? undefined : view.page;
  const empty = page !== undefined && page.readings.length === 0;
  return (
    <>
      {view.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {view.kind === "loading" ? (
        <LoadingRegion className="library-message" />
      ) : page === undefined ? null : empty && offset > 0 ? (
        <PastTheEnd search={search} offset={offset} />
      ) : empty ? (
        <p className="auth-lede">No readings yet.</p>
      ) : (
        <LibraryRows rows={page.readings} />
      )}
      {empty ? null : <Pager search={search} offset={offset} page={page} />}
    </>
  );
}

function LibraryRows({ rows }: { rows: readonly LibraryRow[] }) {
  return (
    <ul className="library-list" aria-label="Readings">
      {rows.map((row) => (
        <LibraryCard key={row.id} row={row} />
      ))}
    </ul>
  );
}

// Another page's link is never the current page. By default the router counts
// `/` as active on every page of the library, since no search is a subset of
// any, and marks Previous with aria-current.
const PAGE_LINK_ACTIVE = { exact: true, includeSearch: true } as const;

/**
 * Previous, the page number, and Next. The page number follows the snapped
 * offset asked for, and Next the backend's `has_more`; while the page is
 * still being read, Next is assumed to exist, so a reader stepping forward
 * keeps the control they are on. A step that cannot be followed stays in
 * place, disabled, so the pager never shifts.
 *
 * The step a reader just followed is usually the one that becomes unavailable
 * on arrival: Next into the last page, Previous back to the first. Losing its
 * href makes the browser blur it, and their next Tab would start again at the
 * top of the document, so the page number takes the focus, naming the page
 * they landed on and leaving Tab where they were. Only that blur: focus
 * leaving for somewhere else carries a relatedTarget, and a step a reader can
 * still follow is not disabled.
 */
function Pager({ search, offset, page }: { search: LibrarySearch; offset: number; page: LibraryPageBody | undefined }) {
  const pageLabel = useRef<HTMLSpanElement>(null);
  const keepFocusInPager = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget === null && event.target.getAttribute("aria-disabled") === "true") {
      pageLabel.current?.focus();
    }
  };

  return (
    <nav className="library-pager" aria-label="Pagination" onBlur={keepFocusInPager}>
      <PagerStep label="Previous" search={offset > 0 ? searchForPage(search, offset - LIBRARY_PAGE_SIZE) : null} />
      <span className="library-pager-page" ref={pageLabel} tabIndex={-1}>
        Page {pageNumber(offset)}
      </span>
      <PagerStep
        label="Next"
        search={page === undefined || page.has_more ? searchForPage(search, offset + LIBRARY_PAGE_SIZE) : null}
      />
    </nav>
  );
}

/** One step: a link while there is a page that way, and the same element disabled when there isn't. */
function PagerStep({ label, search }: { label: string; search: LibrarySearch | null }) {
  return (
    <Link
      to="/"
      // A disabled link has no href, so the search is only read for a step
      // that can be followed.
      search={search ?? {}}
      disabled={search === null}
      activeOptions={PAGE_LINK_ACTIVE}
      className="button library-pager-step"
    >
      {label}
    </Link>
  );
}

/** An offset past the last row: the page number it named, and the first page. */
function PastTheEnd({ search, offset }: { search: LibrarySearch; offset: number }) {
  return (
    <div className="library-message">
      <p className="auth-lede">No readings on page {pageNumber(offset)}.</p>
      <div className="form-actions">
        <Link to="/" search={searchForPage(search, 0)} activeOptions={PAGE_LINK_ACTIVE} className="button">
          First page
        </Link>
      </div>
    </div>
  );
}

/**
 * One card: the state badge when the reading is not simply ready (#415), the
 * title, the summary lead clamped at three lines (the stylesheet's job), and
 * the hostname. The title link is stretched over the whole card, so the card
 * is one target without nesting anything inside a link; the badge and the
 * failure's headline are plain text, so they add nothing the pointer or the
 * keyboard could land on instead. A reading with no title yet (pending,
 * failed) is named by its URL. Long titles wrap and are never truncated.
 */
function LibraryCard({ row }: { row: LibraryRow }) {
  const badge = libraryBadge(row);
  return (
    <li className="library-card">
      {badge ? (
        <p className="library-card-status">
          <span className={`status-badge status-badge-${badge.kind}`}>{badge.label}</span>
          {badge.kind === "failed" ? <span className="library-card-error">{badge.message}</span> : null}
        </p>
      ) : null}
      <h2 className="library-card-title">
        <Link to="/readings/$id" params={{ id: row.id }}>
          {row.title ?? row.url}
        </Link>
      </h2>
      {row.tldr ? <p className="library-card-summary">{row.tldr}</p> : null}
      <p className="library-card-meta">{hostnameOf(row.url)}</p>
    </li>
  );
}
