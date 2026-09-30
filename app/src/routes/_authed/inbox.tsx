import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "../../components/InboxPage";

// The Markdown inbox (reading-lite-fy8t): what agents staged over MCP, waiting
// for the reader to add it to the library or discard it. Under the signed-in
// guard, and read in the browser only (inbox-query.ts).
export const Route = createFileRoute("/_authed/inbox")({
  head: () => ({ meta: [{ title: "Inbox · Reading Lite" }] }),
  component: InboxPage,
});
