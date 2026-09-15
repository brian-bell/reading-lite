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
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import { ReadingDetails } from "./ReadingDetails";
import { ReadingSource, type LoadedImages } from "./ReadingSource";
import {
  ReadingAccountChanged,
  ReadingForbidden,
  ReadingLoading,
  ReadingNotFound,
  ReadingServerError,
} from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";
import { ReadingNovelty, ReadingSummary } from "./ReadingSummary";
import { ReturnTrail, useTrail } from "./ReturnTrail";
import { ViewTabs, tabId, type TabItem } from "./ViewTabs";

// The reading page (#370). The reading is read during the server render
// through the backend entrypoint, dehydrated into the page, and rendered here
// without a second request.
//
// The order of the reading column is the design spec's (Reading surface):
// the return trail when the reader followed a relationship here, title,
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
  if (error) return <ReadingServerError message={error.message} onRetry={() => void refetch()} />;
  if (isPending || !data) return <ReadingLoading />;
  if (data.state === "not-found") return <ReadingNotFound trail={trail} />;
  if (data.state === "forbidden") return <ReadingForbidden />;
  if (data.state === "account-changed") return <ReadingAccountChanged actingTenant={data.acting_tenant} />;
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
