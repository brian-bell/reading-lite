import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { accountViewOf } from "../account-state";
import { NetworkError, isUnauthorized } from "../api/errors";
import { discardInboxItem, promoteInboxItem } from "../api/inbox";
import { ALREADY_PROCESSING_SENTENCE, captureRefusalSentence } from "../capture-refusal";
import { DESK_QUERY_ROOT } from "../desk";
import { whoamiQueryKey, type Identity } from "../identity";
import {
  inboxItemName,
  inboxItemSize,
  inboxQueryKey,
  type DiscardOutcome,
  type InboxItem,
  type InboxItemResult,
  type InboxListResult,
  type PromoteOutcome,
} from "../inbox";
import { inboxItemQueryOptions } from "../inbox-query";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import { dateTimeOn, hostnameOf } from "../reading-presentation";
import { saveNoticeState } from "../save-notice";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { ConfirmDialog } from "./ConfirmDialog";
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

// Reviewing one staged item (reading-lite-fy8t): the Markdown an agent
// staged, rendered as the reading's Source view renders a capture, with the
// two things a person can do about it — add it to the library (promote) or
// discard it. Read in the browser only (inbox-query.ts).
//
// Add to library is a capture write and ends in the save page's outcomes
// (inbox.ts, promoteFromResponse), handled the way SavePage.tsx handles them:
// a reading that lands opens, with the save notice for one that was already
// the reader's; a refusal that will pass is a notice over the item with Try
// again; 403 and 412 replace the page with the shared states. Promote's own
// 404 is the item-gone page, and its 413 a notice with nothing to retry.
//
// Discard deletes the staged text and nothing else, after a confirmation,
// and returns to the inbox. It is sent at once even offline (networkMode
// "always"), as the account page's writes are: a discard held until the
// network returns would land long after the reader stopped looking. A failed
// one offers Retry, which asks again through the dialog rather than resending
// behind the reader's back.
//
// Either write drops the item from the cached list and marks the inbox stale
// without refetching the item on screen, which would briefly answer 404 under
// a page that is about to leave.

/** What the backend decided about a write, other than a reading to open. */
type WriteRefusal =
  Exclude<PromoteOutcome, { kind: "accepted" | "existing" }> | Exclude<DiscardOutcome, { kind: "discarded" }>;

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
  const expectedTenant = expectedLayoutOf(identity);
  const listKey = inboxQueryKey(identity?.user_id ?? "");
  const read = useQuery(inboxItemQueryOptions(queryClient, id, identity));
  const [refused, setRefused] = useState<WriteRefusal | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const promoteRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  // A second write while the first is in flight, or held paused offline,
  // would ask twice. Cleared once the write has settled.
  const writingRef = useRef(false);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const onLoad = useCallback((src: string) => setLoaded((prev) => new Set(prev).add(src)), []);
  const images = useMemo<LoadedImages>(() => ({ loaded, onLoad }), [loaded, onLoad]);

  const promote = useMutation({ mutationFn: () => promoteInboxItem(queryClient, id, expectedTenant) });
  const discard = useMutation({
    mutationFn: () => discardInboxItem(queryClient, id, expectedTenant),
    networkMode: "always",
    retry: 0,
  });

  /** The item has left the inbox: off the cached list now, and the list read again when next shown. */
  async function forgetItem() {
    queryClient.setQueryData<InboxListResult>(listKey, (previous) =>
      previous?.state === "ready"
        ? { state: "ready", value: { ...previous.value, items: previous.value.items.filter((item) => item.id !== id) } }
        : previous,
    );
    await queryClient.invalidateQueries({ queryKey: listKey, refetchType: "none" });
  }

  /** What the last write answered is stale the moment another is asked for. */
  function clearWrites() {
    promote.reset();
    discard.reset();
    setRefused(null);
    setAnnouncement(null);
  }

  /**
   * Adds the item to the library. The button and a notice's Try again both
   * come through here. As on the save page, the outcome is handled in
   * `mutate`'s own callbacks: a paused add that resumes after the reader has
   * left this page reaches the backend and lands in the library without
   * pulling the reader back to it.
   */
  function addToLibrary() {
    if (writingRef.current) return;
    // The notice that asked for this is about to go, and with it the button
    // the reader pressed; focus goes to Add to library rather than the document.
    if (document.activeElement?.closest(".offline-notice")) promoteRef.current?.focus();
    clearWrites();
    writingRef.current = true;
    promote.mutate(undefined, {
      onSuccess: async (outcome) => {
        if (outcome.kind !== "accepted" && outcome.kind !== "existing") {
          if (outcome.kind === "gone") await forgetItem();
          if (outcome.kind === "unavailable" && outcome.id !== undefined) {
            // A failed owner the backend rewrote in place (see SavePage.tsx).
            queryClient.removeQueries({ queryKey: readingQueryKey(outcome.id) });
            await queryClient.invalidateQueries({ queryKey: ["library"] });
            await queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT });
          }
          setRefused(outcome);
          setAnnouncement(noticeSentence(outcome) ?? null);
          return;
        }
        setAnnouncement(outcome.kind === "existing" ? "Opening the reading…" : "Added. Opening the reading…");
        await forgetItem();
        await queryClient.invalidateQueries({ queryKey: ["library"] });
        await queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT });
        queryClient.removeQueries({ queryKey: readingQueryKey(outcome.id) });
        const notice = outcome.kind === "existing" ? outcome.notice : undefined;
        await navigate({
          to: "/readings/$id",
          params: { id: outcome.id },
          state: notice ? { saveNotice: saveNoticeState(notice) } : undefined,
        });
      },
      onSettled: () => {
        writingRef.current = false;
      },
    });
  }

  function openDiscard() {
    if (writingRef.current) return;
    setConfirming(true);
  }

  function discardNow() {
    if (writingRef.current) return;
    clearWrites();
    writingRef.current = true;
    discard.mutate(undefined, {
      onSuccess: async (outcome) => {
        if (outcome.kind !== "discarded") {
          setRefused(outcome);
          return;
        }
        await forgetItem();
        await navigate({ to: "/inbox" });
      },
      onSettled: () => {
        writingRef.current = false;
      },
    });
  }

  const view = viewOf(read, refused, promote, discard);
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
        const busy = promote.isPending || discard.isPending;
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
                    ref={discardRef}
                    aria-disabled={busy || undefined}
                    onClick={openDiscard}
                  >
                    Discard…
                  </button>
                </div>
              </div>
              {current.offline ? <OfflineNotice onRetry={() => void read.refetch()} /> : null}
              <ItemNoticeBanner
                notice={current.notice}
                onTryAgain={addToLibrary}
                onRetryDiscard={() => setConfirming(true)}
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
            {confirming ? (
              <ConfirmDialog
                title="Discard this item?"
                confirmLabel="Discard"
                returnFocus={() => discardRef.current}
                onClose={() => setConfirming(false)}
                onConfirm={discardNow}
              >
                <p>The staged Markdown is deleted from your inbox. Nothing is added to your library.</p>
              </ConfirmDialog>
            ) : null}
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
  promote: { isPaused: boolean; error: unknown },
  discard: { error: unknown },
): ItemView {
  const data = read.data;
  if (refused?.kind === "forbidden" || refused?.kind === "account-changed") return refused;
  if (refused?.kind === "gone" || data?.state === "not-found") return { kind: "not-found" };
  const writeError = [promote.error, discard.error].find((error) => error != null && !isUnauthorized(error));
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
  return { kind: "item", item, offline: readView.kind === "offline", notice: noticeOf(refused, promote, discard) };
}

function noticeOf(
  refused: WriteRefusal | null,
  promote: { isPaused: boolean; error: unknown },
  discard: { error: unknown },
): ItemNotice {
  if (refused && refused.kind !== "forbidden" && refused.kind !== "account-changed" && refused.kind !== "gone") {
    return refused;
  }
  if (promote.isPaused) return { kind: "offline-paused" };
  if (promote.error instanceof NetworkError && promote.error.offline)
    return { kind: "offline-failed", write: "promote" };
  if (discard.error instanceof NetworkError && discard.error.offline)
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
