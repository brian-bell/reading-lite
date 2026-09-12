import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
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
  // The form renders here rather than at /login, so it has to carry this URL
  // itself: without it the library's filters are lost on return, and the
  // request wipes a path stored earlier in this tab (#384 review).
  const href = useLocation({ select: (location) => location.href });
  if (identity === null) return <SignInPage next={href} />;
  return (
    <div className="page">
      <PageHeading>Library</PageHeading>
    </div>
  );
}
