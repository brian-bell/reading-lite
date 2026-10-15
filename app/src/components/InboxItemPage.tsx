import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { accountViewOf } from "../account-state";
import { NetworkError, isUnauthorized } from "../api/errors";
import { ALREADY_PROCESSING_SENTENCE, captureRefusalSentence } from "../capture-refusal";
import { whoamiQueryKey, type Identity } from "../identity";
import { inboxItemName, inboxItemSize, type InboxItem, type InboxItemResult } from "../inbox";
import { inboxItemQueryOptions } from "../inbox-query";
import { type InboxWriteRefusal, useInboxWrites } from "../inbox-writes";
import { dateTimeOn, hostnameOf } from "../reading-presentation";
import { saveNoticeState } from "../save-notice";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { ExternalLink } from "./ExternalLink";
import { PageHeading, PageStateFocus } from "./PageHeading";
import {
  AccountChanged,
  Forbidden,
  InboxItemNotFound,
  InlineNotice,
  LoadingRegion,
  OfflineNotice,
  ServerError,
} from "./ReadingStates";
import { BackToLibrary } from "./BackToLibrary";
import { SourceMarkdown, type LoadedImages } from "./ReadingSource";

/** What the backend decided about a write, other than a reading to open. */
type WriteRefusal = InboxWriteRefusal;

/** What is said above the item without replacing it. */
type ItemNotice =
  | { kind: "none" }
  /** An add started without a network: held, and sent when the browser is back. */
  | { kind: "offline-paused" }
  /** A write that failed with the network gone: asking again is the way on. */
  | { kind: "offline-failed"; write: "promote" | "discard" }
  | Exclude<WriteRefusal, { kind: "forbidden" | "account-changed" | "gone" }>;

type ItemView =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "server-error"; message: string; failed: "read" | "write" }
  | { kind: "item"; item: InboxItem; offline: boolean; notice: ItemNotice };

/** The 503 sentence, in the words of the button the reader pressed. */
const UNAVAILABLE = "Adding to your library is unavailable right now.";

const TOO_LARGE =
  "This Markdown is too large to add to your library once it takes the failed reading's title. Discard it, or have the agent stage it again with a title.";

export function InboxItemPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const read = useQuery(inboxItemQueryOptions(queryClient, id, identity));
  const [opening, setOpening] = useState<string | null>(null);
  const promoteRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const onLoad = useCallback((src: string) => setLoaded((prev) => new Set(prev).add(src)), []);
  const images = useMemo<LoadedImages>(() => ({ loaded, onLoad }), [loaded, onLoad]);
  const writes = useInboxWrites(id, {
    onPromoted: async (outcome) => {
      setOpening(outcome.kind === "existing" ? "Opening the reading…" : "Added. Opening the reading…");
      const notice = outcome.kind === "existing" ? outcome.notice : undefined;
      await navigate({
        to: "/readings/$id",
        params: { id: outcome.id },
        state: notice ? { saveNotice: saveNoticeState(notice) } : undefined,
      });
    },
    onDiscarded: () => navigate({ to: "/inbox" }),
  });

  function addToLibrary() {
    if (writes.pending) return;
    // The notice that asked for this is about to go, and with it the button
    // the reader pressed; focus goes to Add to library rather than the document.
    if (document.activeElement?.closest(".offline-notice")) promoteRef.current?.focus();
    setOpening(null);
    writes.promote();
  }

  function clearWrites() {
    setOpening(null);
    writes.reset();
  }

  const announcement = opening ?? (writes.refusal === null ? null : (noticeSentence(writes.refusal) ?? null));
  const view = viewOf(read, writes.refusal, writes);
  return <PageStateFocus kind={view.kind}>{pageFor(view)}</PageStateFocus>;

  function pageFor(current: ItemView) {
    switch (current.kind) {
      case "loading":
        return (
          <div className="page reading">
            <PageHeading>Inbox item</PageHeading>
            <LoadingRegion />
          </div>
        );
      case "offline":
        return (
          <div className="page reading">
            <PageHeading>Inbox item</PageHeading>
            <OfflineNotice onRetry={() => void read.refetch()} />
          </div>
        );
      case "not-found":
        return <InboxItemNotFound />;
      case "forbidden":
        return (
          <Forbidden>
            <div className="form-actions">
              <BackToLibrary className="button" />
            </div>
          </Forbidden>
        );
      case "account-changed":
        return <AccountChanged actingTenant={current.actingTenant} />;
      case "server-error":
        return (
          <ServerError
            message={current.message}
            onRetry={() => {
              if (current.failed === "write") clearWrites();
              else void read.refetch();
            }}
          />
        );
      case "item": {
        const { item } = current;
        const busy = writes.pending;
        const staged = dateTimeOn(item.updated_at);
        return (
          <div className="page reading">
            <article className="reading-column">
              <Link to="/inbox" className="reading-back">
                Back to inbox
              </Link>
              <div className="reading-head reading-head-actions">
                <PageHeading>{inboxItemName(item)}</PageHeading>
                <p className="reading-meta">
                  <span>
                    <ExternalLink href={item.url}>{hostnameOf(item.url)}</ExternalLink>
                  </span>
                  <span>{inboxItemSize(item.markdown_bytes)}</span>
                  {staged ? <span>Staged {staged}</span> : null}
                </p>
                <div className="reading-actions">
                  {/* aria-disabled, not disabled, as on the save page: the
                      reader keeps their place while a write runs, and the
                      state page that may replace this one takes that focus. */}
                  <button
                    type="button"
                    className="button button-primary"
                    ref={promoteRef}
                    aria-disabled={busy || undefined}
                    onClick={addToLibrary}
                  >
                    Add to library
                  </button>
                  <button
                    type="button"
                    className="button"
                    ref={writes.discardAnchor}
                    aria-disabled={busy || undefined}
                    onClick={writes.askDiscard}
                  >
                    Discard…
                  </button>
                </div>
              </div>
              {current.offline ? <OfflineNotice onRetry={() => void read.refetch()} /> : null}
              <ItemNoticeBanner
                notice={current.notice}
                onTryAgain={addToLibrary}
                onRetryDiscard={writes.askDiscard}
              />
              {/* The page's standing polite region, as on the save page: a
                  notice's sentence is said here, and heard only while that
                  notice is on screen for those who cannot see it. */}
              <p
                className={current.notice.kind === "none" ? "form-status" : "form-status visually-hidden"}
                role="status"
              >
                {announcement}
              </p>
              <section className="inbox-preview" aria-labelledby="inbox-preview-heading">
                <h2 id="inbox-preview-heading" className="inbox-preview-title">
                  Preview
                </h2>
                <SourceMarkdown markdown={item.markdown} base={item.url} images={images} />
              </section>
            </article>
            {writes.discardDialog}
          </div>
        );
      }
    }
  }
}

/**
 * The page's state, most decisive first: what a write was refused with, then
 * an item that is gone, then a write that failed outright, then the read.
 */
function viewOf(
  read: { data: InboxItemResult | undefined; error: unknown; fetchStatus: "fetching" | "paused" | "idle" },
  refused: WriteRefusal | null,
  writes: { promotePaused: boolean; promoteError: unknown; discardError: unknown },
): ItemView {
  const data = read.data;
  if (refused?.kind === "forbidden" || refused?.kind === "account-changed") return refused;
  if (refused?.kind === "gone" || data?.state === "not-found") return { kind: "not-found" };
  const writeError = [writes.promoteError, writes.discardError].find((error) => error != null && !isUnauthorized(error));
  const offlineWrite = writeError instanceof NetworkError && writeError.offline;
  if (writeError != null && !offlineWrite) {
    return {
      kind: "server-error",
      message: writeError instanceof Error ? writeError.message : String(writeError),
      failed: "write",
    };
  }
  const readView = accountViewOf({ data, error: read.error, fetchStatus: read.fetchStatus });
  switch (readView.kind) {
    case "loading":
    case "forbidden":
    case "account-changed":
      return readView;
    case "server-error":
      return { ...readView, failed: "read" };
    case "offline":
      if (readView.value === undefined) return { kind: "offline" };
      break;
  }
  const item = readView.kind === "offline" || readView.kind === "ready" ? readView.value : undefined;
  if (item === undefined) return { kind: "loading" };
  return { kind: "item", item, offline: readView.kind === "offline", notice: noticeOf(refused, writes) };
}

function noticeOf(
  refused: WriteRefusal | null,
  writes: { promotePaused: boolean; promoteError: unknown; discardError: unknown },
): ItemNotice {
  if (refused && refused.kind !== "forbidden" && refused.kind !== "account-changed" && refused.kind !== "gone") {
    return refused;
  }
  if (writes.promotePaused) return { kind: "offline-paused" };
  if (writes.promoteError instanceof NetworkError && writes.promoteError.offline)
    return { kind: "offline-failed", write: "promote" };
  if (writes.discardError instanceof NetworkError && writes.discardError.offline)
    return { kind: "offline-failed", write: "discard" };
  return { kind: "none" };
}

/** What a notice says, in one place: the banner renders it and the page's live region announces it. */
function noticeSentence(notice: WriteRefusal): string | undefined {
  switch (notice.kind) {
    case "limited":
    case "guard-unavailable":
    case "unavailable":
    case "key-required":
      return captureRefusalSentence(notice, UNAVAILABLE);
    case "already-processing":
      return ALREADY_PROCESSING_SENTENCE;
    case "too-large":
      return TOO_LARGE;
    case "invalid":
      return notice.message;
    default:
      return undefined;
  }
}

function ItemNoticeBanner({
  notice,
  onTryAgain,
  onRetryDiscard,
}: {
  notice: ItemNotice;
  onTryAgain: () => void;
  onRetryDiscard: () => void;
}) {
  switch (notice.kind) {
    case "none":
      return null;
    case "offline-paused":
      return <OfflineNotice message="You're offline. This item will be added when your connection returns." />;
    case "offline-failed":
      return <OfflineNotice onRetry={notice.write === "promote" ? onTryAgain : onRetryDiscard} />;
    case "already-processing":
      // The reading this would re-import is being processed; the backend
      // finishes it, and asking again while it runs gets the same answer.
      return <InlineNotice message={ALREADY_PROCESSING_SENTENCE} live={false} />;
    case "too-large":
      return <InlineNotice message={TOO_LARGE} live={false} />;
    case "invalid":
      return <InlineNotice message={notice.message} live={false} />;
    default:
      return (
        <CaptureRefusalNotice refusal={notice} unavailable={UNAVAILABLE} onTryAgain={onTryAgain}>
          {notice.kind === "unavailable" && notice.id ? (
            <Link className="notice-link" to="/readings/$id" params={{ id: notice.id }}>
              Open the reading
            </Link>
          ) : null}
        </CaptureRefusalNotice>
      );
  }
}
