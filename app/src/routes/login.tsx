import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { redirectSignedInFromLogin, validateLoginSearch } from "../auth/guards";
import { SignInPage } from "../components/SignInPage";
import { whoamiQueryOptions } from "../identity-query";

// Magic-link request with `?next=` and recent-auth `?step_up=1` (acceptance
// matrix, Routes). Signed in without step-up goes straight to `next`.
export const Route = createFileRoute("/login")({
  validateSearch: validateLoginSearch,
  beforeLoad: redirectSignedInFromLogin,
  head: () => ({ meta: [{ title: "Sign in · Reading Lite" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { next, step_up } = Route.useSearch();
  const { data: identity } = useQuery(whoamiQueryOptions());
  return <SignInPage next={next} lockedEmail={step_up && identity ? identity.email : undefined} />;
}
