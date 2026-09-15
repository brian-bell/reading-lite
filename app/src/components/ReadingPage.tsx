import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf, savedOn, sourceLabel } from "../reading-presentation";
import { readingQueryOptions } from "../reading-query";
import { hasRelationships } from "../reading-relationships";
import type { Reading } from "../reading";
import type { TrailHop } from "../reading-trail";
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import {
  ReadingAccountChanged,
  ReadingForbidden,
  ReadingLoading,
  ReadingNotFound,
  ReadingServerError,
} from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";
import { ReadingSummary } from "./ReadingSummary";
import { ReturnTrail, useTrail } from "./ReturnTrail";

// The reading page (#370). The reading is read during the server render
// through the backend entrypoint, dehydrated into the page, and rendered here
// without a second request.
//
// The order of the reading column is the design spec's (Reading surface):
// the return trail when the reader followed a relationship here, title,
// metadata line, tags, the phone jump to the context column, status card when
// active or failed, the view's content, then the novelty panel. Connections
// and tensions sit beside the column on desktop and after it on phones
// (#371). The Source view and its tabs (#372) and Details (#373) follow in
// their own slices; the actions in the heading row (Reprocess, Open original
// URL) arrive with capture in Phase 4.

export function ReadingPage({ id }: { id: string }) {
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
  return <ReadingSurface reading={data.reading} trail={trail} />;
}

/**
 * Title, metadata line, tags, status, and the Summary view (design spec,
 * Reading surface). A very long title wraps and is never truncated, so the
 * heading carries the whole thing.
 */
function ReadingSurface({ reading, trail }: { reading: Reading; trail: readonly TrailHop[] }) {
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
        <ReadingSummary reading={reading} />
      </article>
      {context ? <ReadingContext reading={reading} /> : null}
    </div>
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
