import { createFileRoute } from "@tanstack/react-router";
import { LibraryHome } from "../../components/LibraryPage";
import { loadLibraryPage } from "../../library-query";
import { libraryParamsOf, validateLibrarySearch } from "../../library-search";

// The library (#413), at /library since the desk took `/` (reading-lite-kl7y.7).
// The loader reads the page the URL names (`?offset=`, #414) during the
// server render, so it is dehydrated into the page and the browser renders it
// without asking again. A page change in the browser starts the read and
// mounts the page at once, so its loading and offline states show there
// (#416). Signed out, the _authed guard sends the reader to sign in and back.
export const Route = createFileRoute("/_authed/library")({
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => libraryParamsOf(search),
  loader: ({ context, deps }) => loadLibraryPage(context.queryClient, deps),
  head: () => ({ meta: [{ title: "Library · Reading Lite" }] }),
  component: LibraryRoute,
});

function LibraryRoute() {
  return <LibraryHome search={Route.useSearch()} />;
}
