import { createFileRoute } from "@tanstack/react-router";
import { VerifyPage, validateVerifySearch } from "../components/VerifyPage";

// The path the backend mails (MAGIC_LINK_VERIFY_PATH); /login/verify is the alias.
export const Route = createFileRoute("/auth/verify")({
  validateSearch: validateVerifySearch,
  head: () => ({ meta: [{ title: "Complete sign-in · Reading Lite" }] }),
  component: AuthVerifyPage,
});

function AuthVerifyPage() {
  const { next, purpose } = Route.useSearch();
  return <VerifyPage next={next} purpose={purpose} />;
}
