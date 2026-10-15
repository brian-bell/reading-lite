import { createFileRoute, redirect } from "@tanstack/react-router";
import { DeskHome } from "../components/DeskPage";
import { loadDeskPage } from "../desk-query";
import { hasLibraryParams } from "../library-search";

// The desk (reading-lite-kl7y.7). Signed in, the loader reads GET /api/desk
// for this visit during the server render, so it is dehydrated into the page
// and the browser renders it without asking again. Signed out, the landing
// renders in place, with no redirect. The library's old address,
// `/?q=&tag=&offset=`, redirects to `/library` with the same parameters, so
// old links and stored return paths keep working.
export const Route = createFileRoute("/")({
  beforeLoad: ({ search }) => {
    if (hasLibraryParams(search)) throw redirect({ to: "/library", search, replace: true });
  },
  loader: ({ context }) => loadDeskPage(context.queryClient),
  head: () => ({ meta: [{ title: "Desk · Reading Lite" }] }),
  component: DeskRoute,
});

function DeskRoute() {
  return <DeskHome visit={Route.useLoaderData()} />;
}
