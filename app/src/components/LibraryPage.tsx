import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import { FIRST_LIBRARY_PAGE, type LibraryParams, type LibraryRow } from "../library";
import { libraryQueryOptions } from "../library-query";
import { hostnameOf } from "../reading-presentation";
import { PageHeading } from "./PageHeading";
import { DelayedText } from "./ReadingStates";
import { SignInPage } from "./SignInPage";

// The library (#413, first slice of #404). The first page is read during the
// server render through the backend entrypoint, dehydrated into the page, and
// rendered here without a second request.
//
// The heading stays "Library" in every state, so focus after a route change
// lands on the same page whatever the rows turned out to be. Status badges,
// tags, filters, pagination, and the matrix's library and common states are
// later slices of #404; until they land, anything but a page of rows is one
// plain sentence under the heading.

/** `/`: the sign-in form in place when signed out, the library when signed in. */
export function LibraryHome() {
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
  return <LibraryPage />;
}

export function LibraryPage({ params = FIRST_LIBRARY_PAGE }: { params?: LibraryParams }) {
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
      ) : data.page.readings.length === 0 ? (
        <p className="auth-lede">No readings yet.</p>
      ) : (
        <LibraryRows rows={data.page.readings} />
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
