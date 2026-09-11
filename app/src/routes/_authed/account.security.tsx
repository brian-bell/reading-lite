import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "../../components/PageHeading";

// Placeholder until the account page lands (Phase 5, #340). The route exists
// now for the account menu link and the step-up return path.
export const Route = createFileRoute("/_authed/account/security")({
  head: () => ({ meta: [{ title: "Account · Reading Lite" }] }),
  component: AccountPage,
});

function AccountPage() {
  return (
    <div className="page">
      <PageHeading>Account</PageHeading>
    </div>
  );
}
