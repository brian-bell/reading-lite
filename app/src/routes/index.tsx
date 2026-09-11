import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "../components/PageHeading";
import { SignInPage } from "../components/SignInPage";
import { whoamiQueryOptions } from "../identity-query";

// Library placeholder until Phase 4 (#339). Signed out, the sign-in form
// renders in place, with no redirect, as in the current SPA.
export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Library · Reading Lite" }] }),
  component: LibraryPage,
});

function LibraryPage() {
  const { data: identity } = useQuery(whoamiQueryOptions());
  if (identity === null) return <SignInPage />;
  return (
    <div className="page">
      <PageHeading>Library</PageHeading>
    </div>
  );
}
