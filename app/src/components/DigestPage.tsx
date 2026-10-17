import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import { ACCOUNT_SECURITY_PATH } from "../auth/return-path";
import { digestSendOf, readingsSoFar, type DigestPreview, type DigestSend } from "../digest-preview";
import { digestPreviewQueryOptions } from "../digest-preview-query";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf } from "../reading-presentation";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { AccountChanged, Forbidden, InlineNotice, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";

// The digest preview (reading-lite-kl7y.10; design spec, Digest preview): the
// next digest mail as it stands now, and the desk's Next digest tile. Only
// what the mail sends: its subject, then each reading's title, host, and
// tl;dr. Read in the browser on both; the server render is the page's frame
// with its content busy.

function useDigestPreview() {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(digestPreviewQueryOptions(queryClient, identity));
  return { view: accountViewOf({ data, error, fetchStatus }), onRetry: () => void refetch() };
}

export function DigestPage() {
  const { view, onRetry } = useDigestPreview();
  return <PageStateFocus kind={view.kind}>{pageFor(view, onRetry)}</PageStateFocus>;
}

function pageFor(view: AccountView<DigestPreview>, onRetry: () => void) {
  switch (view.kind) {
    case "forbidden":
      return (
        <Forbidden>
          <div className="form-actions">
            <BackToDesk />
          </div>
        </Forbidden>
      );
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={onRetry} />;
    case "offline":
      return <DigestFrame preview={view.value} notice={<OfflineNotice onRetry={onRetry} />} />;
    case "loading":
      return <DigestFrame notice={<LoadingRegion className="library-message" />} />;
    case "ready":
      return <DigestFrame preview={view.value} />;
  }
}

function BackToDesk() {
  return (
    <Link to="/" className="button">
      Back to desk
    </Link>
  );
}

function DigestFrame({ preview, notice }: { preview?: DigestPreview; notice?: ReactNode }) {
  return (
    <div className="page digest">
      <div className="digest-head">
        <PageHeading>Digest preview</PageHeading>
        <BackToDesk />
      </div>
      {notice}
      {preview ? <DigestSendView send={digestSendOf(preview)} /> : null}
    </div>
  );
}

function DigestSendView({ send }: { send: DigestSend }) {
  if (send.kind === "off") {
    return (
      <div className="library-message">
        <p className="auth-lede">Digests are off. Turn on a daily or weekly digest in account settings.</p>
        <div className="form-actions">
          <Link to={ACCOUNT_SECURITY_PATH} className="button button-primary">
            Account settings
          </Link>
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="auth-lede">Goes out {send.goesOut}.</p>
      <p className="form-hint digest-hint">
        The {send.cadence} mail as it stands now. Readings processed before then are added. A reading reprocessed in
        this period appears again, because the digest picks readings by their last update. Change the schedule in{" "}
        <Link to={ACCOUNT_SECURITY_PATH}>account settings</Link>.
      </p>
      {send.items.length === 0 ? (
        <div className="library-message">
          <p className="auth-lede">Nothing has arrived yet. No mail is sent for an empty period.</p>
        </div>
      ) : (
        <article className="digest-mail" aria-label="Digest mail">
          <p className="digest-subject">{send.subject}</p>
          <ul className="digest-list" aria-label={readingsSoFar(send.items.length)}>
            {send.items.map((item) => (
              <li key={item.id}>
                <h2 className="digest-item-title">
                  <Link to="/readings/$id" params={{ id: item.id }}>
                    {item.title}
                  </Link>
                </h2>
                <p className="digest-item-meta">{hostnameOf(item.url)}</p>
                <p className="digest-item-lead">{item.tldr}</p>
              </li>
            ))}
          </ul>
        </article>
      )}
    </>
  );
}

/**
 * The desk's Next digest tile: how many readings the next mail carries so far
 * and when it goes out, or that digests are off. Its own read, so a failure
 * stays in the tile and the rest of the desk is unaffected.
 */
export function NextDigestTile() {
  const { view, onRetry } = useDigestPreview();
  const preview = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
  if (preview === undefined) {
    return (
      <section className="desk-tile" aria-label="Next digest">
        <h2 className="desk-tile-eyebrow">Next digest</h2>
        {view.kind === "loading" || view.kind === "offline" ? (
          <LoadingRegion className="desk-tile-meta" />
        ) : (
          <InlineNotice
            message="The next digest isn't available right now."
            onAction={view.kind === "server-error" ? onRetry : undefined}
          />
        )}
      </section>
    );
  }
  const send = digestSendOf(preview);
  return (
    <section className="desk-tile" aria-label="Next digest">
      <h2 className="desk-tile-eyebrow">Next digest</h2>
      {send.kind === "off" ? (
        <>
          <p className="desk-tile-title">Digests are off</p>
          <p className="desk-tile-meta">A daily or weekly email of new readings.</p>
          <div className="desk-tile-actions">
            <Link to={ACCOUNT_SECURITY_PATH} className="button">
              Account settings
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="desk-tile-title">{readingsSoFar(send.items.length)}</p>
          <p className="desk-tile-meta">Goes out {send.goesOut}.</p>
          <div className="desk-tile-actions">
            <Link to="/digest" className="button">
              Preview
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
