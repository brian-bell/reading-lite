import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { accountViewOf, type AccountView } from "../account-state";
import { whoamiQueryKey, type Identity } from "../identity";
import { inboxItemName, inboxItemSize, type InboxList } from "../inbox";
import { inboxQueryOptions } from "../inbox-query";
import { dateTimeOn, hostnameOf } from "../reading-presentation";
import { BackToLibrary } from "./BackToLibrary";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { AccountChanged, Forbidden, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";

// The Markdown inbox (reading-lite-fy8t): every item an agent staged, most
// recently staged first, as the backend lists them. Each row opens the item's
// own page, where the reader previews it and adds it to the library or
// discards it (InboxItemPage.tsx). Read in the browser only (inbox-query.ts),
// with the account page's common states (account-state.ts): 403 and 412
// replace the list, offline is a notice over whatever was loaded, and
// anything else is the retryable server error.
//
// Rows are the library's cards: a title link stretched over the card (the URL
// when the agent gave no title), then the host, size, and when it was staged.

export function InboxPage() {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(inboxQueryOptions(queryClient, identity));
  const view = accountViewOf({ data, error, fetchStatus });
  return <PageStateFocus kind={view.kind}>{pageFor(view, () => void refetch())}</PageStateFocus>;
}

function pageFor(view: AccountView<InboxList>, onRetry: () => void) {
  switch (view.kind) {
    case "forbidden":
      return (
        <Forbidden>
          <div className="form-actions">
            <BackToLibrary className="button" />
          </div>
        </Forbidden>
      );
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={onRetry} />;
    default: {
      const listed = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
      return (
        <div className="page library">
          <PageHeading>Inbox</PageHeading>
          <p className="auth-lede inbox-lede">
            Markdown your agents import waits here until you add it to your library or discard it.
          </p>
          {view.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
          {view.kind === "loading" ? <LoadingRegion className="library-message" /> : null}
          {listed ? <InboxItems listed={listed} /> : null}
        </div>
      );
    }
  }
}

function InboxItems({ listed }: { listed: InboxList }) {
  if (listed.items.length === 0) {
    return (
      <div className="library-message">
        <p className="auth-lede">Your inbox is empty.</p>
      </div>
    );
  }
  return (
    <ul className="library-list" aria-label="Inbox items">
      {listed.items.map((item) => {
        const staged = dateTimeOn(item.updated_at);
        return (
          <li key={item.id} className="library-card">
            <h2 className="library-card-title">
              <Link to="/inbox/$id" params={{ id: item.id }}>
                {inboxItemName(item)}
              </Link>
            </h2>
            <p className="reading-meta library-card-meta">
              <span>{hostnameOf(item.url)}</span>
              <span>{inboxItemSize(item.markdown_bytes)}</span>
              {staged ? <span>Staged {staged}</span> : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
