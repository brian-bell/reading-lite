import { createFileRoute } from "@tanstack/react-router";
import { ReadingPage } from "../../components/ReadingPage";
import { prefetchOnDesk } from "../../desk-query";
import { whoamiQueryKey, type Identity } from "../../identity";
import { readingQueryKey, type ReadingResult } from "../../reading";
import { readingQueryOptions } from "../../reading-query";
import { readingViewOf, validateReadingSearch } from "../../reading-view";

// Server-rendered reading detail (#370). The loader reads the reading during
// the server render, so it is dehydrated into the page and the browser renders
// it without asking again. `?view=source` selects the Source view (#372); its
// Markdown is fetched in the browser once selected, never here.

export const Route = createFileRoute("/_authed/readings/$id")({
  validateSearch: validateReadingSearch,
  // Identity is already loaded: the _authed guard read it before this ran.
  // Taking it from the cache keeps the tenant pin free of an extra round trip.
  // prefetchQuery never throws, so a 404 or an unavailable backend renders its
  // state in the page instead of failing the route.
  // A reading on the desk has the session bar above its title, so what is on
  // the desk is read after it, during the same render.
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    await queryClient.prefetchQuery(readingQueryOptions(queryClient, params.id, identity));
    const result = queryClient.getQueryData<ReadingResult>(readingQueryKey(params.id));
    if (result?.state === "ready" && result.reading.desk_position !== undefined) {
      await prefetchOnDesk(queryClient, identity);
    }
  },
  head: () => ({ meta: [{ title: "Reading · Reading Lite" }] }),
  component: ReadingRoute,
});

function ReadingRoute() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  return <ReadingPage id={id} view={readingViewOf(search)} />;
}
