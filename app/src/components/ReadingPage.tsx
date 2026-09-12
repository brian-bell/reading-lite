import { useQuery, useQueryClient } from "@tanstack/react-query";
import { whoamiQueryKey, type Identity } from "../identity";
import { hostnameOf, savedOn, sourceLabel } from "../reading-presentation";
import { readingQueryOptions } from "../reading-query";
import type { Reading } from "../reading";
import { PageHeading } from "./PageHeading";
import {
  ReadingAccountChanged,
  ReadingForbidden,
  ReadingLoading,
  ReadingNotFound,
  ReadingServerError,
} from "./ReadingStates";
import { ReadingStatusCard } from "./ReadingStatusCard";

// The reading page (#370). This slice is the data path and the states: the
// reading is read during the server render through the backend entrypoint,
// dehydrated into the page, and rendered here without a second request. The
// Summary view's lead, summary Markdown, tags, and novelty panel land in the
// next slice; relationships (#371), source (#372), and details (#373) follow.

export function ReadingPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, isPending, refetch } = useQuery(readingQueryOptions(queryClient, id, identity));

  // A 401 never gets here: the shell shows the expired-session page at this URL.
  if (error) return <ReadingServerError message={error.message} onRetry={() => void refetch()} />;
  if (isPending || !data) return <ReadingLoading />;
  if (data.state === "not-found") return <ReadingNotFound />;
  if (data.state === "forbidden") return <ReadingForbidden />;
  if (data.state === "account-changed") return <ReadingAccountChanged actingTenant={data.acting_tenant} />;
  return <ReadingSurface reading={data.reading} />;
}

/**
 * Title, metadata line, and status (design spec, Reading surface). A very long
 * title wraps and is never truncated, so the heading carries the whole thing.
 */
function ReadingSurface({ reading }: { reading: Reading }) {
  const saved = savedOn(reading.created_at);
  const source = sourceLabel(reading.source_type);
  return (
    <article className="page reading">
      <PageHeading>{reading.title ?? reading.url}</PageHeading>
      <p className="reading-meta">
        <span>{hostnameOf(reading.url)}</span>
        {saved ? <span>{saved}</span> : null}
        {source ? <span>{source}</span> : null}
      </p>
      <ReadingStatusCard reading={reading} />
    </article>
  );
}
