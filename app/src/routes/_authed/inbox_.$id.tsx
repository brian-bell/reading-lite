import { createFileRoute } from "@tanstack/react-router";
import { InboxItemPage } from "../../components/InboxItemPage";

// One staged item (reading-lite-fy8t): its preview, Add to library, and
// Discard. Not nested under /inbox's page, which is the list. Under the
// signed-in guard, and read in the browser only (inbox-query.ts).
export const Route = createFileRoute("/_authed/inbox_/$id")({
  head: () => ({ meta: [{ title: "Inbox item · Reading Lite" }] }),
  component: InboxItemRoute,
});

function InboxItemRoute() {
  const { id } = Route.useParams();
  // Keyed by the item, so moving from one item to another starts afresh.
  return <InboxItemPage key={id} id={id} />;
}
