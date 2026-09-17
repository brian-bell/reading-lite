import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../components/AccountPage";

// Account / security (#340.1, Phase 5 of #340). Sessions list, revoke one,
// and revoke-all live here; email, tokens, notifications, and deletion join
// later on this same route. Under the signed-in guard: a link from the
// account menu or a step-up return signs the reader in and lands here.
export const Route = createFileRoute("/_authed/account/security")({
  head: () => ({ meta: [{ title: "Account · Reading Lite" }] }),
  component: AccountPage,
});
