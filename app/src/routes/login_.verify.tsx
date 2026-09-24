import { createFileRoute } from "@tanstack/react-router";
import { VerifyPage, validateVerifySearch } from "../components/VerifyPage";

// Alias of /auth/verify, kept from the legacy SPA. Not nested under /login.
export const Route = createFileRoute("/login_/verify")({
  validateSearch: validateVerifySearch,
  head: () => ({ meta: [{ title: "Complete sign-in · Reading Lite" }] }),
  component: LoginVerifyPage,
});

function LoginVerifyPage() {
  const { next, purpose } = Route.useSearch();
  return <VerifyPage next={next} purpose={purpose} />;
}
