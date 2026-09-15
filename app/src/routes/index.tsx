import { createFileRoute } from "@tanstack/react-router";
import { LibraryHome } from "../components/LibraryPage";
import { prefetchFirstLibraryPage } from "../library-query";

// The library (#413). Signed in, the loader reads the first page during the
// server render, so it is dehydrated into the page and the browser renders it
// without asking again. Signed out, the sign-in form renders in place, with no
// redirect, as in the current SPA.
export const Route = createFileRoute("/")({
  loader: ({ context }) => prefetchFirstLibraryPage(context.queryClient),
  head: () => ({ meta: [{ title: "Library · Reading Lite" }] }),
  component: LibraryHome,
});
