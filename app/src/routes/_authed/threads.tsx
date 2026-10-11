import { createFileRoute } from "@tanstack/react-router";
import { ThreadsPage } from "../../components/ThreadsPage";
import { whoamiQueryKey, type Identity } from "../../identity";
import { relationshipsQueryOptions } from "../../relationships-query";

// The library's threads, its tension pairs, and the readings that stand alone
// (reading-lite-kl7y.3). The loader reads the relationship graph during the
// server render, so it is dehydrated into the page; identity is already in the
// cache, read by the _authed guard. prefetchQuery never throws, so a refusal
// or an unavailable backend renders its state in the page.
export const Route = createFileRoute("/_authed/threads")({
  loader: ({ context }) => {
    const identity = context.queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    return context.queryClient.prefetchQuery(relationshipsQueryOptions(context.queryClient, identity));
  },
  head: () => ({ meta: [{ title: "Threads · Reading Lite" }] }),
  component: ThreadsPage,
});
