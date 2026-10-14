import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { accountViewOf } from "../account-state";
import { NetworkError, isUnauthorized } from "../api/errors";
import { ALREADY_PROCESSING_SENTENCE, captureRefusalSentence } from "../capture-refusal";
import { whoamiQueryKey, type Identity } from "../identity";
import { inboxItemName, inboxItemSize, type DeskInboxBlock, type DeskInboxFold, type InboxItemMeta } from "../inbox";
import { inboxItemQueryOptions } from "../inbox-query";
import { useInboxWrites, type InboxWrites } from "../inbox-writes";
import { dateTimeOn, hostnameOf } from "../reading-presentation";
import { saveNoticeState } from "../save-notice";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { InlineNotice, LoadingRegion, OfflineNotice } from "./ReadingStates";
import { SourceMarkdown, type LoadedImages } from "./ReadingSource";

const UNAVAILABLE = "Adding to your library is unavailable right now.";

const TOO_LARGE =
  "This Markdown is too large to add to your library once it takes the failed reading's title. Discard it, or have the agent stage it again with a title.";

export function DeskInboxSection({
  fold,
  onRetry,
  Section,
}: {
  fold: DeskInboxFold;
  onRetry: () => void;
  Section: (props: { title: string; count?: number; children: ReactNode }) => ReactNode;
}) {
  if (fold.kind === "pending" || fold.kind === "empty") return null;
  if (fold.kind === "blocked") {
    return (
      <Section title="Inbox">
        <DeskInboxBlocked block={fold.block} onRetry={onRetry} />
      </Section>
    );
  }
  return (
    <Section title="Inbox" count={fold.total}>
      {fold.shown.map((item) => (
        <DeskInboxRow key={item.id} item={item} />
      ))}
      {fold.total > fold.shown.length ? (
        <li className="desk-row desk-row-more">
          <Link to="/inbox" className="button button-quiet">
            Show all {fold.total}
          </Link>
        </li>
      ) : null}
    </Section>
  );
}

function DeskInboxBlocked({ block, onRetry }: { block: DeskInboxBlock; onRetry: () => void }) {
  return (
    <li className="desk-row">
      {block.kind === "forbidden" ? <p className="desk-row-note">You don't have access to this.</p> : null}
      {block.kind === "account-changed" ? (
        <div>
          <p className="desk-row-note">This tab is signed in to a different account than the page expects.</p>
          {block.actingTenant ? <p className="form-hint">Signed in as {block.actingTenant}.</p> : null}
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      ) : null}
      {block.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {block.kind === "error" ? <InlineNotice message={block.message} onAction={onRetry} /> : null}
    </li>
  );
}

function DeskInboxRow({ item }: { item: InboxItemMeta }) {
  const navigate = useNavigate();
  const writes = useInboxWrites(item.id, {
    onPromoted: async (outcome) => {
      const notice = outcome.kind === "existing" ? outcome.notice : undefined;
      await navigate({
        to: "/readings/$id",
        params: { id: outcome.id },
        state: notice ? { saveNotice: saveNoticeState(notice) } : undefined,
      });
    },
  });
  const staged = dateTimeOn(item.updated_at);
  return (
    <li className="desk-row desk-inbox-row">
      <div className="desk-row-text">
        <p className={item.title === null ? "desk-row-title inbox-card-url" : "desk-row-title"}>
          <Link to="/inbox/$id" params={{ id: item.id }}>
            {inboxItemName(item)}
          </Link>
        </p>
        <p className="desk-row-note">
          {[hostnameOf(item.url), inboxItemSize(item.markdown_bytes), staged ? `Staged ${staged}` : undefined]
            .filter((part) => part !== undefined)
            .join(" · ")}
        </p>
      </div>
      <div className="desk-row-actions">
        <button
          type="button"
          className="button button-primary"
          aria-disabled={writes.pending || undefined}
          onClick={writes.promote}
        >
          Add to library
        </button>
        <button
          type="button"
          className="button"
          ref={writes.discardAnchor}
          aria-disabled={writes.pending || undefined}
          onClick={writes.askDiscard}
        >
          Discard…
        </button>
      </div>
      <DeskInboxPreview id={item.id} base={item.url} />
      <DeskInboxNotice writes={writes} />
      {writes.discardDialog}
    </li>
  );
}

function DeskInboxPreview({ id, base }: { id: string; base: string }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const read = useQuery(inboxItemQueryOptions(queryClient, id, identity));
  const images = useLoadedImages();
  const data = read.data;
  if (data?.state === "not-found") {
    return <p className="desk-inbox-preview desk-row-note">This item is no longer in your inbox.</p>;
  }
  const view = accountViewOf({ data, error: read.error, fetchStatus: read.fetchStatus });
  switch (view.kind) {
    case "loading":
      return <LoadingRegion className="desk-inbox-preview" />;
    case "forbidden":
      return <p className="desk-inbox-preview desk-row-note">You don't have access to this.</p>;
    case "account-changed":
      return (
        <p className="desk-inbox-preview desk-row-note">
          This tab is signed in to a different account than the page expects.
        </p>
      );
    case "server-error":
      return (
        <div className="desk-inbox-preview">
          <InlineNotice message={view.message} onAction={() => void read.refetch()} />
        </div>
      );
    case "offline":
      if (view.value === undefined) {
        return (
          <div className="desk-inbox-preview">
            <OfflineNotice onRetry={() => void read.refetch()} />
          </div>
        );
      }
      return (
        <div className="desk-inbox-preview" tabIndex={0} aria-label="Preview">
          <SourceMarkdown markdown={view.value.markdown} base={base} images={images} />
        </div>
      );
    case "ready":
      return (
        <div className="desk-inbox-preview" tabIndex={0} aria-label="Preview">
          <SourceMarkdown markdown={view.value.markdown} base={base} images={images} />
        </div>
      );
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

function useLoadedImages(): LoadedImages {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const onLoad = useCallback((src: string) => setLoaded((prev) => new Set(prev).add(src)), []);
  return useMemo(() => ({ loaded, onLoad }), [loaded, onLoad]);
}

function DeskInboxNotice({ writes }: { writes: InboxWrites }) {
  const shown = deskNotice(writes);
  return (
    <>
      {shown === null ? null : <div className="desk-inbox-notice">{shown.node}</div>}
      <p className="visually-hidden" role="status">
        {shown?.sentence}
      </p>
    </>
  );
}

function deskNotice(writes: InboxWrites): { sentence: string; node: ReactNode } | null {
  const refusal = writes.refusal;
  if (refusal) {
    switch (refusal.kind) {
      case "forbidden":
        return said("You don't have access to this.");
      case "account-changed": {
        const sentence = "This tab is signed in to a different account than the page expects.";
        return {
          sentence,
          node: (
            <InlineNotice message={sentence} live={false}>
              <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </InlineNotice>
          ),
        };
      }
      case "gone":
        return said("This item isn't in your inbox.");
      case "already-processing":
        return said(ALREADY_PROCESSING_SENTENCE);
      case "too-large":
        return said(TOO_LARGE);
      case "invalid":
        return said(refusal.message);
      case "limited":
      case "guard-unavailable":
      case "unavailable":
      case "key-required":
        return {
          sentence: captureRefusalSentence(refusal, UNAVAILABLE),
          node: (
            <CaptureRefusalNotice refusal={refusal} unavailable={UNAVAILABLE} onTryAgain={writes.promote}>
              {refusal.kind === "unavailable" && refusal.id ? (
                <Link className="notice-link" to="/readings/$id" params={{ id: refusal.id }}>
                  Open the reading
                </Link>
              ) : null}
            </CaptureRefusalNotice>
          ),
        };
      default: {
        const unreachable: never = refusal;
        return unreachable;
      }
    }
  }
  if (writes.promotePaused) {
    return said("You're offline. This item will be added when your connection returns.");
  }
  if (writes.promoteError instanceof NetworkError && writes.promoteError.offline) {
    return said("You're offline. Check your connection and try again.", writes.promote);
  }
  if (writes.discardError instanceof NetworkError && writes.discardError.offline) {
    return said("You're offline. Check your connection and try again.", writes.askDiscard);
  }
  const thrown = [writes.promoteError, writes.discardError].find((error) => error != null && !isUnauthorized(error));
  if (thrown == null) return null;
  const retry = writes.promoteError != null ? writes.promote : writes.askDiscard;
  return said(thrown instanceof Error ? thrown.message : String(thrown), retry);
}

function said(sentence: string, onAction?: () => void): { sentence: string; node: ReactNode } {
  return { sentence, node: <InlineNotice message={sentence} onAction={onAction} live={false} /> };
}
