import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf, savedOn, sourceLabel } from "../reading-presentation";
import { readingQueryOptions } from "../reading-query";
import { hasRelationships } from "../reading-relationships";
import { searchForView, type ReadingView } from "../reading-view";
import { isProcessing, type Reading, type ReadingResult } from "../reading";
import { categorize } from "../reading-failure";
import { readingSchedule } from "../status-refresh";
import type { TrailHop } from "../reading-trail";
import { saveNoticeOf } from "../save-notice";
import type { SaveNotice } from "../save";
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import { ReadingDetails } from "./ReadingDetails";
import { ReadingSource, type LoadedImages } from "./ReadingSource";
import { BackToLibrary } from "./BackToLibrary";
import { AccountChanged, ReadingForbidden, ReadingLoading, ReadingNotFound, ServerError } from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";
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
// notice a save left when the URL was already in the library (#432), title,
// metadata line, tags, the phone jump to the context column, status card when
// active or failed, the Summary/Source tabs (#372), the selected view's
// content, the novelty panel below either view, then the collapsed Details
// section (#373). Connections and tensions sit beside the column on desktop
// and after it on phones (#371). The actions in the heading row (Reprocess,
// Open original URL) arrive with capture in Phase 4.

export function ReadingPage({ id, view = "summary" }: { id: string; view?: ReadingView }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const watch = useStatusWatch<ReadingResult>({ keyOf: watchKeyOf, schedule: readingSchedule });
  const { data, error, isPending, refetch } = useQuery(readingQueryOptions(queryClient, id, identity, watch.options));
  const trail = useTrail();
  const announcement = useOutcomeAnnouncement(id, data);

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
 * The outcome of a watched attempt, said once in the polite region (acceptance
 * matrix, Status refresh contract, Terminal): only when this page saw the
 * reading being processed and then saw it finish, so a reading that opens
 * already ready or failed announces nothing. The library's rows changed with
 * it, so their queries are invalidated. Focus stays where the reader left it.
 */
function useOutcomeAnnouncement(id: string, data: ReadingResult | undefined): string | null {
  const queryClient = useQueryClient();
  const key = watchKeyOf(data);
  const previous = useRef<{ id: string; key: string | null }>({ id, key });
  const [announced, setAnnounced] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    const was = previous.current;
    previous.current = { id, key };
    if (was.id !== id) {
      // The route component is reused when a connection leads to another
      // reading; what the last one said is not said again on coming back.
      setAnnounced(null);
      return;
    }
    if (was.key === null || key !== null) return;
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    if (data?.state === "ready") setAnnounced({ id, text: outcomeText(data.reading) });
  }, [id, key, data, queryClient]);

  // Until the effect clears it, a newly shown reading has said nothing yet.
  return announced?.id === id ? announced.text : null;
}

/**
 * A failed reprocess leaves `status: "ready"` — the backend restores the
 * previous manifest — and records the failure on `last_attempt`, so the
 * attempt decides, as the library's "Reprocess failed" badge does.
 */
function outcomeText(reading: Reading): string {
  const reprocessFailed = reading.status === "ready" && reading.last_attempt?.status === "failed";
  if (reading.status !== "failed" && !reprocessFailed) return "Processing finished. This reading is ready.";
  const lead = reprocessFailed ? "Processing again failed; the previous version is still here." : "Processing failed.";
  const error = reading.error ?? reading.last_attempt?.error;
  return error ? `${lead} ${categorize(error).headline}` : lead;
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
}: {
  reading: Reading;
  view: ReadingView;
  trail: readonly TrailHop[];
  watch: WatchStatus;
  checkFailed: boolean;
  onCheck: () => void;
  announcement: string | null;
}) {
  const saved = savedOn(reading.created_at);
  const source = sourceLabel(reading.source_type);
  const context = hasRelationships(reading);
  return (
    <div className={context ? "page reading reading-layout" : "page reading"}>
      <article className="reading-column">
        <BackToLibrary className="reading-back" />
        <ReturnTrail hops={trail} />
        <SaveNoticeBanner />
        <PageHeading>{reading.title ?? reading.url}</PageHeading>
        <p className="reading-meta">
          <span>{hostnameOf(reading.url)}</span>
          {saved ? <span>{saved}</span> : null}
          {source ? <span>{source}</span> : null}
        </p>
        <ReadingTags tags={reading.tags} />
        {context ? <ContextJump /> : null}
        {/* Always here, so a change to its text is announced (see SaveNoticeBanner). */}
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
        <ReadingStatusCard reading={reading} watch={watch} checkFailed={checkFailed} onCheck={onCheck} />
        <ReadingViews key={reading.id} reading={reading} view={view} />
        <ReadingNovelty reading={reading} />
        <ReadingDetails key={`details-${reading.id}`} reading={reading} />
      </article>
      {context ? <ReadingContext reading={reading} /> : null}
    </div>
  );
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
function ReadingViews({ reading, view }: { reading: Reading; view: ReadingView }) {
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
        <ReadingSource reading={reading} onReadSummary={readSummary} images={images} />
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
          <Link className="tag" to="/" search={{ tag }}>
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}
