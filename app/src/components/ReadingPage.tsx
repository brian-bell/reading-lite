import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DESK_QUERY_ROOT } from "../desk";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf, publishedOn, savedOn, sourceLabel } from "../reading-presentation";
import { readingQueryOptions } from "../reading-query";
import { relationshipsQueryKey } from "../relationships";
import { relationshipsQueryOptions } from "../relationships-query";
import { threadFor, threadsOf, type Thread } from "../threads";
import { hasRelationships } from "../reading-relationships";
import { searchForView, type ReadingView } from "../reading-view";
import { isProcessing, type Reading, type ReadingResult } from "../reading";
import { categorize } from "../reading-failure";
import { diagnosticsQueryKey } from "../reading-diagnostics";
import { sourceQueryKey } from "../reading-source";
import { readingState } from "../reading-state";
import { readingSchedule } from "../status-refresh";
import type { TrailHop } from "../reading-trail";
import { saveNoticeOf } from "../save-notice";
import type { SaveNotice } from "../save";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeskToggle } from "./DeskToggle";
import { SessionBar } from "./SessionBar";
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import { ReadingDetails } from "./ReadingDetails";
import { ReadingSource, type ImportCopyAction, type LoadedImages } from "./ReadingSource";
import { BackToLibrary } from "./BackToLibrary";
import { ImportCopyDialog } from "./ImportCopyDialog";
import {
  AccountChanged,
  ReadingForbidden,
  ReadingLoading,
  ReadingNotFound,
  ServerError,
} from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";
import { ReprocessNoticeBanner, reprocessNoticeSentence } from "./ReprocessNotice";
import { useReprocess, type Reprocess, type ReprocessNotice } from "./use-reprocess";
import { useStatusWatch, type WatchStatus } from "./use-status-watch";
import { ReadingNovelty, ReadingSummary } from "./ReadingSummary";
import { useRenderedLocation } from "./rendered-location";
import { ReturnTrail, useTrail } from "./ReturnTrail";
import { ViewTabs, tabId, type TabItem } from "./ViewTabs";

// The reading page (#370). The reading is read during the server render
// through the backend entrypoint, dehydrated into the page, and rendered here
// without a second request.
//
// The order of the reading column is the design spec's (Reading surface),
// after "Back to library" (#407): the return trail when the reader followed a relationship here, the one-time
// notice a save left when the URL was already in the library (#432), the
// session bar on a reading on the desk (reading-lite-kl7y.7) or the desk
// toggle on a ready one that is not (reading-lite-kl7y.6), title,
// metadata line, tags, the phone jump to the context column, status card when
// active or failed, the Summary/Source tabs (#372), the selected view's
// content, the novelty panel below either view, then the collapsed Details
// section (#373). Connections and tensions sit beside the column on desktop
// and after it on phones (#371). A ready reading's Reprocess sits in the
// heading row (#410); Open original URL is still to come. Import a copy (#411)
// is offered where the Worker could not read the page: a failed reading's
// status card, and the Source view of a reading whose source is unavailable.

export function ReadingPage({ id, view = "summary" }: { id: string; view?: ReadingView }) {
  // The route component is reused when a connection or history leads to
  // another reading. Keyed on the id, everything this page holds about one
  // reading — its watch, its announcement, a reprocess answer or a request in
  // flight, an open confirmation — starts over for the next, rather than being
  // carried to it or shown again on coming back.
  return <ReadingPageFor key={id} id={id} view={view} />;
}

function ReadingPageFor({ id, view }: { id: string; view: ReadingView }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const watch = useStatusWatch<ReadingResult>({ keyOf: watchKeyOf, schedule: readingSchedule });
  const { data, error, isPending, refetch } = useQuery(readingQueryOptions(queryClient, id, identity, watch.options));
  const trail = useTrail();
  const announcement = useOutcomeAnnouncement(id, data);
  const reprocess = useReprocess(id, data?.state === "ready" && isProcessing(data.reading));

  // A 401 never gets here: the shell shows the expired-session page at this URL.
  // A failed background check leaves the reading on screen; the status card
  // counts it (use-status-watch.ts).
  if (error && !data) return <ServerError message={error.message} onRetry={() => void refetch()} />;
  if (isPending || !data) return <ReadingLoading />;
  if (data.state === "not-found") return <ReadingNotFound trail={trail} />;
  if (data.state === "forbidden") return <ReadingForbidden />;
  if (data.state === "account-changed") return <AccountChanged actingTenant={data.acting_tenant} />;
  return (
    <ReadingSurface
      reading={data.reading}
      view={view}
      trail={trail}
      watch={watch.status}
      checkFailed={error !== null}
      onCheck={() => void refetch()}
      announcement={announcement}
      reprocess={reprocess}
    />
  );
}

/**
 * What the status watch follows: the running attempt, so a new attempt
 * (reprocess, retry, import) starts a new watch. A pending manifest with no
 * attempt recorded is still watched, under the reading's own id.
 */
function watchKeyOf(data: ReadingResult | undefined): string | null {
  if (data?.state !== "ready" || !isProcessing(data.reading)) return null;
  return data.reading.active_attempt?.id ?? `pending:${data.reading.id}`;
}

/**
 * The thread this reading is in, from the relationship graph (design spec,
 * Screens: Reading). Only observed here, never prefetched, so it is read in
 * the browser after hydration and the reading's server render stays bounded.
 * Nothing while it loads or when the read fails or is refused: the strip
 * takes no space then, and the rest of the page is unaffected.
 */
function useThreadOf(id: string): Thread | undefined {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, status } = useQuery(relationshipsQueryOptions(queryClient, identity));
  const graph = status === "success" && data.state === "ready" ? data.value : undefined;
  return useMemo(() => (graph ? threadFor(threadsOf(graph), id) : undefined), [graph, id]);
}

/** Something said once in the polite region. A new object each time, so saying the same words again is a new event. */
interface Said {
  text: string;
}

/**
 * The outcome of a watched attempt, said once in the polite region (acceptance
 * matrix, Status refresh contract, Terminal): only when this page saw the
 * reading being processed and then saw it finish, so a reading that opens
 * already ready or failed announces nothing. The library's rows changed with
 * it, and so did what the attempt rewrote and logged — the Source view's
 * extracted Markdown and the Details diagnostics, which never go stale on
 * their own — so their queries are invalidated. Focus stays where the reader
 * left it.
 */
function useOutcomeAnnouncement(id: string, data: ReadingResult | undefined): Said | null {
  const queryClient = useQueryClient();
  const key = watchKeyOf(data);
  const previous = useRef<string | null>(key);
  const [announced, setAnnounced] = useState<Said | null>(null);

  useEffect(() => {
    const was = previous.current;
    previous.current = key;
    if (was === null || key !== null) return;
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT });
    void queryClient.invalidateQueries({ queryKey: relationshipsQueryKey });
    void queryClient.invalidateQueries({ queryKey: sourceQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: diagnosticsQueryKey(id) });
    if (data?.state === "ready") setAnnounced({ text: outcomeText(data.reading) });
  }, [id, key, data, queryClient]);

  return announced;
}

/**
 * A failed reprocess leaves `status: "ready"` — the backend restores the
 * previous manifest — and records the failure on `last_attempt`, so the
 * shared classification (reading-state.ts) decides, as the library's
 * "Reprocess failed" badge does.
 */
function outcomeText(reading: Reading): string {
  const state = readingState(reading);
  if (state.kind !== "failed" && state.kind !== "reprocess-failed") return "Processing finished. This reading is ready.";
  const lead =
    state.kind === "reprocess-failed" ? "Processing again failed; the previous version is still here." : "Processing failed.";
  return state.error ? `${lead} ${categorize(state.error).headline}` : lead;
}

/**
 * Title, metadata line, tags, status, the views, novelty, and Details (design
 * spec, Reading surface). A very long title wraps and is never truncated, so the
 * heading carries the whole thing.
 */
function ReadingSurface({
  reading,
  view,
  trail,
  watch,
  checkFailed,
  onCheck,
  announcement,
  reprocess,
}: {
  reading: Reading;
  view: ReadingView;
  trail: readonly TrailHop[];
  watch: WatchStatus;
  checkFailed: boolean;
  onCheck: () => void;
  announcement: Said | null;
  reprocess: Reprocess;
}) {
  const published = publishedOn(reading.source_date);
  const saved = savedOn(reading.created_at);
  const source = sourceLabel(reading.source_type);
  const thread = useThreadOf(reading.id);
  const context = hasRelationships(reading) || thread !== undefined;
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);
  const reprocessRef = useRef<HTMLButtonElement>(null);
  const cardActionRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const notice = reprocess.notice;
  const said = useSaid(notice, announcement);
  // Nothing is asked for while a request is in flight or an attempt runs:
  // the backend would refuse it (409), and a ready reading's confirmation
  // would ask the reader to agree to a paid run that cannot start.
  const busy = reprocess.sending || isProcessing(reading);

  /** The control a dialog gives focus back to: whichever opened it, or `fallback`. */
  function rememberOpener(fallback: HTMLElement | null) {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : fallback;
  }

  /** A ready reading's run is confirmed every time it is asked for, from whichever control asked. */
  function confirmReprocess() {
    if (busy) return;
    rememberOpener(reprocessRef.current);
    setConfirming(true);
  }

  function openImport() {
    if (busy) return;
    rememberOpener(null);
    setImporting(true);
  }

  const importCopy: ImportCopyAction = { onOpen: openImport, busy };

  function tryAgain() {
    if (reading.status === "ready") confirmReprocess();
    else if (!busy) {
      // The notice whose Try again this was goes with the send; focus goes to
      // the card's Retry rather than the document.
      if (document.activeElement?.closest(".offline-notice")) cardActionRef.current?.focus();
      reprocess.send();
    }
  }

  return (
    <div className="page reading">
      <article className="reading-column">
        <BackToLibrary className="reading-back" />
        <ReturnTrail hops={trail} />
        <SaveNoticeBanner />
        {reading.desk_position !== undefined ? (
          <SessionBar reading={{ id: reading.id, desk_position: reading.desk_position }} />
        ) : reading.status === "ready" ? (
          <DeskToggle reading={reading} className="reading-desk" />
        ) : null}
        {/* The actions follow the metadata in reading order, which is where
            phones show them; on wider screens they sit in the heading row. */}
        <div className={reading.status === "ready" ? "reading-head reading-head-actions" : "reading-head"}>
          <PageHeading>{reading.title ?? reading.url}</PageHeading>
          <p className="reading-meta">
            <span>{hostnameOf(reading.url)}</span>
            {published ? <span>{published}</span> : null}
            {saved ? <span>{saved}</span> : null}
            {source ? <span>{source}</span> : null}
          </p>
          {reading.status === "ready" ? (
            <div className="reading-actions">
              {/* Kept while an attempt runs, aria-disabled, so the focus the
                  dialog returned to it is not dropped when the card appears. */}
              <button
                type="button"
                className="button"
                ref={reprocessRef}
                aria-disabled={busy || undefined}
                onClick={confirmReprocess}
              >
                Reprocess
              </button>
            </div>
          ) : null}
        </div>
        <ReadingTags tags={reading.tags} />
        {context ? <ContextJump /> : null}
        {/* Always here, so a change to its text is announced (see SaveNoticeBanner). */}
        <p className="visually-hidden" role="status">
          {said}
        </p>
        <ReadingStatusCard
          reading={reading}
          watch={watch}
          checkFailed={checkFailed}
          onCheck={onCheck}
          onRetry={() => {
            if (!busy) reprocess.send();
          }}
          onImportCopy={openImport}
          sending={reprocess.sending}
          actionRef={cardActionRef}
        />
        {notice ? (
          <ReprocessNoticeBanner
            notice={notice}
            request="reprocess"
            onTryAgain={tryAgain}
            onCheck={onCheck}
            onImportCopy={openImport}
          />
        ) : null}
        <ReadingViews key={reading.id} reading={reading} view={view} importCopy={importCopy} />
        <ReadingNovelty reading={reading} />
        <ReadingDetails key={`details-${reading.id}`} reading={reading} />
      </article>
      {context ? <ReadingContext reading={reading} thread={thread} /> : null}
      {confirming ? (
        <ConfirmDialog
          title="Reprocess this reading?"
          confirmLabel="Reprocess"
          returnFocus={() => (openerRef.current?.isConnected ? openerRef.current : reprocessRef.current)}
          onClose={() => setConfirming(false)}
          onConfirm={() => reprocess.send()}
        >
          <p>
            Reprocessing runs this reading through the paid pipeline again and replaces its captured content,
            summary, and connections.
          </p>
          <p>If it fails, the current version stays.</p>
        </ConfirmDialog>
      ) : null}
      {importing ? (
        <ImportCopyDialog
          reading={reading}
          onImport={reprocess.importCopy}
          sending={reprocess.sending}
          onClose={() => setImporting(false)}
          // A failed reading's opener goes with the failure once the import
          // starts, and a notice's goes with the notice; the card's first
          // control is the same button throughout, and a ready reading always
          // has Reprocess.
          returnFocus={() =>
            openerRef.current?.isConnected ? openerRef.current : (cardActionRef.current ?? reprocessRef.current)
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The page's one polite region says the latest of two things: a reprocess
 * notice or the watched attempt's outcome. Each arrives as a new object, so
 * this follows events rather than text: the same outcome said again after a
 * notice (a retry refused, then one that failed the same way) is said again.
 * A notice going away empties the region rather than handing it back to an
 * earlier outcome, which would be said a second time.
 */
function useSaid(notice: ReprocessNotice | null, announcement: Said | null): string | null {
  const [said, setSaid] = useState<string | null>(null);
  const lastNotice = useRef<string | null>(null);
  useEffect(() => {
    setSaid(announcement?.text ?? null);
  }, [announcement]);
  // After the outcome's effect, so an answer to what the reader just pressed
  // wins when both land in one render. A notice going away empties the region
  // only if the region still says that notice: an outcome said in the same
  // render (an already-processing notice cleared because its attempt ended)
  // stays.
  useEffect(() => {
    if (notice) {
      lastNotice.current = reprocessNoticeSentence(notice, "reprocess");
      setSaid(lastNotice.current);
      return;
    }
    const gone = lastNotice.current;
    lastNotice.current = null;
    if (gone !== null) setSaid((current) => (current === gone ? null : current));
  }, [notice]);
  return said;
}

/** What each notice says, in the reader's terms. */
const SAVE_NOTICE_TEXT: Record<SaveNotice, string> = {
  "already-saved": "Already in your library",
  "still-processing": "Already saved and still processing",
};

/**
 * What a save that opened an existing reading left behind (#432), read from
 * the history entry the way the return trail is — so the Summary/Source
 * switch, which replaces the entry and keeps its state, keeps it, browser Back
 * to that entry shows it again, and a reload (another document load) or a
 * plain link to the same reading carries none.
 *
 * The live region is always here and its text is what changes, as the save
 * form's and the sign-in form's are: a `role="status"` element that mounts
 * with its text already in it is not reliably announced. An empty one is
 * `display: none`, so it takes no space on the readings that have no notice —
 * which is nearly all of them.
 */
function SaveNoticeBanner() {
  const notice = useRenderedLocation((location) => saveNoticeOf(location.state));
  return (
    <p className="reading-notice" role="status">
      {notice ? SAVE_NOTICE_TEXT[notice] : null}
    </p>
  );
}

const VIEW_TABS_ID = "view";
const VIEW_TABS: readonly TabItem<ReadingView>[] = [
  { key: "summary", label: "Summary" },
  { key: "source", label: "Source" },
];

/**
 * Summary/Source tabs backed by `?view=source` (#372; design spec, Routes and
 * navigation state). Only a ready reading has two views to offer: a pending
 * or failed one shows its status card and whatever summary it still has, and
 * `?view=source` on it means Summary like any other value would.
 *
 * Switching replaces the history entry and keeps the location's state (the
 * return trail) and scroll position: the reader is choosing how to read this
 * reading, not going somewhere.
 */
function ReadingViews({
  reading,
  view,
  importCopy,
}: {
  reading: Reading;
  view: ReadingView;
  importCopy: ImportCopyAction;
}) {
  const navigate = useNavigate();
  // The images the reader loaded in the Source view live here, above the tab
  // panel, so switching to Summary and back does not turn them back into
  // placeholders. Consent is per reading: the route component is reused when
  // a connection leads to another reading, so ReadingSurface keys this on the
  // reading id and the set starts empty there.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const onLoad = useCallback((src: string) => setLoaded((prev) => new Set(prev).add(src)), []);
  const images = useMemo<LoadedImages>(() => ({ loaded, onLoad }), [loaded, onLoad]);
  if (reading.status !== "ready") return <ReadingSummary reading={reading} />;

  function selectView(next: ReadingView) {
    void navigate({
      to: "/readings/$id",
      params: { id: reading.id },
      search: searchForView(next),
      state: true,
      replace: true,
      resetScroll: false,
    });
  }

  function readSummary() {
    selectView("summary");
    document.getElementById(tabId(VIEW_TABS_ID, "summary"))?.focus();
  }

  return (
    <ViewTabs label="View" idPrefix={VIEW_TABS_ID} tabs={VIEW_TABS} selected={view} onSelect={selectView}>
      {view === "source" ? (
        <ReadingSource reading={reading} onReadSummary={readSummary} images={images} importCopy={importCopy} />
      ) : (
        <ReadingSummary reading={reading} />
      )}
    </ViewTabs>
  );
}

/**
 * Tags open the library filtered by that tag (design spec, Data mapping). They
 * are links, not buttons, because they are a fresh navigation to the library
 * URL `/?tag=T`: its first page, at the top.
 */
function ReadingTags({ tags }: { tags: string[] | undefined }) {
  if (!tags || tags.length === 0) return null;
  return (
    <ul className="reading-tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag}>
          <Link className="tag" to="/library" search={{ tag }}>
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}
