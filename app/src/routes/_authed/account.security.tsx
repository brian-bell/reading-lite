import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../components/AccountPage";

// Account / security (#340.1, #340.6, #340.8; Phase 5 of #340). Email change,
// notification settings, sessions (list, revoke one, revoke-all), and account
// deletion live here. Under the signed-in guard: a link from the account menu
// or a step-up return signs the reader in and lands here.
export const Route = createFileRoute("/_authed/account/security")({
  head: () => ({ meta: [{ title: "Account · Reading Lite" }] }),
  component: AccountPage,
});
