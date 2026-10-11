import { createFileRoute } from "@tanstack/react-router";
import { ThreadPage } from "../../components/ThreadsPage";
import { whoamiQueryKey, type Identity } from "../../identity";
import { relationshipsQueryOptions } from "../../relationships-query";

// One thread (reading-lite-kl7y.3): the thread containing reading `$id`, so a
// link by any member's id survives a change of oldest reading. Not nested
// under /threads's page, which is the list. Server-rendered from the same
// relationship graph as /threads.
export const Route = createFileRoute("/_authed/threads_/$id")({
  loader: ({ context }) => {
    const identity = context.queryClient.getQueryData<Identity | null>(whoamiQueryKey);
    return context.queryClient.prefetchQuery(relationshipsQueryOptions(context.queryClient, identity));
  },
  head: () => ({ meta: [{ title: "Thread · Reading Lite" }] }),
  component: ThreadRoute,
});

function ThreadRoute() {
  const { id } = Route.useParams();
  return <ThreadPage id={id} />;
}
