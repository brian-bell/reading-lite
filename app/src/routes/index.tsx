import { createFileRoute } from "@tanstack/react-router";
import { LibraryHome } from "../components/LibraryPage";
import { loadLibraryPage } from "../library-query";
import { libraryParamsOf, validateLibrarySearch } from "../library-search";

// The library (#413). Signed in, the loader reads the page the URL names
// (`?offset=`, #414) during the server render, so it is dehydrated into the
// page and the browser renders it without asking again. A page change in the
// browser starts the read and mounts the page at once, so its loading and
// offline states show there (#416). Signed out, the sign-in form renders in
// place, with no redirect, as in the legacy SPA.
export const Route = createFileRoute("/")({
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => libraryParamsOf(search),
  loader: ({ context, deps }) => loadLibraryPage(context.queryClient, deps),
  head: () => ({ meta: [{ title: "Library · Reading Lite" }] }),
  component: LibraryRoute,
});

function LibraryRoute() {
  return <LibraryHome search={Route.useSearch()} />;
}
