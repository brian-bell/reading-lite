import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf, savedOn, sourceLabel } from "../reading-presentation";
import { readingQueryOptions } from "../reading-query";
import { hasRelationships } from "../reading-relationships";
import { searchForView, type ReadingView } from "../reading-view";
import type { Reading } from "../reading";
import type { TrailHop } from "../reading-trail";
import { saveNoticeOf } from "../save-notice";
import type { SaveNotice } from "../save";
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import { ReadingDetails } from "./ReadingDetails";
import { ReadingSource, type LoadedImages } from "./ReadingSource";
import { AccountChanged, ReadingForbidden, ReadingLoading, ReadingNotFound, ServerError } from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";
import { ReadingNovelty, ReadingSummary } from "./ReadingSummary";
import { useRenderedLocation } from "./rendered-location";
import { ReturnTrail, useTrail } from "./ReturnTrail";
import { ViewTabs, tabId, type TabItem } from "./ViewTabs";

// The reading page (#370). The reading is read during the server render
// through the backend entrypoint, dehydrated into the page, and rendered here
// without a second request.
//
// The order of the reading column is the design spec's (Reading surface):
// the return trail when the reader followed a relationship here, the one-time
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
  const { data, error, isPending, refetch } = useQuery(readingQueryOptions(queryClient, id, identity));
  const trail = useTrail();

  // A 401 never gets here: the shell shows the expired-session page at this URL.
  if (error) return <ServerError message={error.message} onRetry={() => void refetch()} />;
  if (isPending || !data) return <ReadingLoading />;
  if (data.state === "not-found") return <ReadingNotFound trail={trail} />;
  if (data.state === "forbidden") return <ReadingForbidden />;
  if (data.state === "account-changed") return <AccountChanged actingTenant={data.acting_tenant} />;
  return <ReadingSurface reading={data.reading} view={view} trail={trail} />;
}

/**
 * Title, metadata line, tags, status, the views, novelty, and Details (design
 * spec, Reading surface). A very long title wraps and is never truncated, so the
 * heading carries the whole thing.
 */
function ReadingSurface({ reading, view, trail }: { reading: Reading; view: ReadingView; trail: readonly TrailHop[] }) {
  const saved = savedOn(reading.created_at);
  const source = sourceLabel(reading.source_type);
  const context = hasRelationships(reading);
  return (
    <div className={context ? "page reading reading-layout" : "page reading"}>
      <article className="reading-column">
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
        <ReadingStatusCard reading={reading} />
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
 * are links, not buttons, because they are a navigation to the library URL the
 * spec fixes as `/?q=&tag=&offset=` — the library reads `tag` when its filters
 * land in Phase 4 (#339); the URL it lands on is already settled.
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
