import { createFileRoute } from "@tanstack/react-router";
import { CatalogHome } from "../../components/CatalogPage";
import { catalogViewOf, validateCatalogSearch } from "../../catalog";
import { loadCatalogPage } from "../../catalog-query";

export const Route = createFileRoute("/_authed/catalog")({
  validateSearch: validateCatalogSearch,
  loaderDeps: ({ search }) => catalogViewOf(search),
  loader: ({ context, deps }) => loadCatalogPage(context.queryClient, deps),
  head: () => ({ meta: [{ title: "Catalog · Reading Lite" }] }),
  component: CatalogRoute,
});

function CatalogRoute() {
  return <CatalogHome search={Route.useSearch()} />;
}
