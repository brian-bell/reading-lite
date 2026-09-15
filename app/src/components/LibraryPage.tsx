import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useRef, type FocusEvent } from "react";
import { whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import type { LibraryPage as LibraryPageBody, LibraryRow } from "../library";
import { libraryQueryOptions } from "../library-query";
import {
  LIBRARY_PAGE_SIZE,
  libraryParamsOf,
  pageNumber,
  searchForPage,
  type LibrarySearch,
} from "../library-search";
import { hostnameOf } from "../reading-presentation";
import { PageHeading } from "./PageHeading";
import { DelayedText } from "./ReadingStates";
import { SignInPage } from "./SignInPage";

// The library (#413, first slice of #404). The page the URL names is read
// during the server render through the backend entrypoint, dehydrated into the
// page, and rendered here without a second request. Previous and Next (#414)
// are links to the neighbouring page's URL, so a page change is a client-side
// navigation that reads through same-origin /api/readings, and a reload or a
// deep link renders the same page on the server.
//
// The heading stays "Library" in every state, so focus after a route change
// lands on the same page whatever the rows turned out to be. Status badges,
// tags, filters, and the matrix's common states are later slices of #404;
// until they land, anything but a page of rows is one plain sentence under the
// heading.

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

export function LibraryPage({ search }: { search: LibrarySearch }) {
  const params = libraryParamsOf(search);
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, isPending, refetch } = useQuery(libraryQueryOptions(queryClient, params, identity));

  return (
    <div className="page library">
      <PageHeading>Library</PageHeading>
      {error ? (
        // A 401 never gets here: the shell shows the expired-session page.
        <div className="library-message">
          <p className="auth-lede">Something went wrong on our side. {error.message}</p>
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        </div>
      ) : isPending || !data ? (
        <div className="library-message" aria-busy="true">
          <DelayedText delayMs={300}>Loading…</DelayedText>
        </div>
      ) : data.state === "forbidden" ? (
        <p className="auth-lede">You don't have access to this.</p>
      ) : data.state === "account-changed" ? (
        <p className="auth-lede">This tab is signed in to a different account than the page expects.</p>
      ) : data.page.readings.length === 0 && params.offset > 0 ? (
        <PastTheEnd search={search} offset={params.offset} />
      ) : data.page.readings.length === 0 ? (
        <p className="auth-lede">No readings yet.</p>
      ) : (
        <>
          <LibraryRows rows={data.page.readings} />
          <Pager search={search} offset={params.offset} page={data.page} />
        </>
      )}
    </div>
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
 * offset asked for, and Next the backend's `has_more`. A step that cannot be
 * followed stays in place, disabled, so the pager never shifts.
 *
 * The step a reader just followed is usually the one that becomes unavailable
 * on arrival: Next into the last page, Previous back to the first. Losing its
 * href makes the browser blur it, and their next Tab would start again at the
 * top of the document, so the page number takes the focus, naming the page
 * they landed on and leaving Tab where they were. Only that blur: focus
 * leaving for somewhere else carries a relatedTarget, and a step a reader can
 * still follow is not disabled.
 */
function Pager({ search, offset, page }: { search: LibrarySearch; offset: number; page: LibraryPageBody }) {
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
      <PagerStep label="Next" search={page.has_more ? searchForPage(search, offset + LIBRARY_PAGE_SIZE) : null} />
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
 * A plain card: the title link is stretched over the whole card, so the card
 * is one target without nesting anything inside a link. A reading with no
 * title yet (pending, failed) is named by its URL. Long titles wrap and are
 * never truncated.
 */
function LibraryCard({ row }: { row: LibraryRow }) {
  return (
    <li className="library-card">
      <h2 className="library-card-title">
        <Link to="/readings/$id" params={{ id: row.id }}>
          {row.title ?? row.url}
        </Link>
      </h2>
      <p className="library-card-meta">{hostnameOf(row.url)}</p>
    </li>
  );
}
