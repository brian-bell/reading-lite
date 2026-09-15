import { createFileRoute } from "@tanstack/react-router";
import { ReadingPage } from "../../components/ReadingPage";
import { whoamiQueryKey, type Identity } from "../../identity";
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
  loader: ({ context, params }) => {
    const identity = context.queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    return context.queryClient.prefetchQuery(readingQueryOptions(context.queryClient, params.id, identity));
  },
  head: () => ({ meta: [{ title: "Reading · Reading Lite" }] }),
  component: ReadingRoute,
});

function ReadingRoute() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  return <ReadingPage id={id} view={readingViewOf(search)} />;
}
