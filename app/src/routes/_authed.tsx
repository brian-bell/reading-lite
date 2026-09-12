import { createFileRoute } from "@tanstack/react-router";
import { requireSignedIn } from "../auth/guards";

// Pages that need a session. Signed out, a direct link goes to
// /login?next=<this URL> and returns here after sign-in.
export const Route = createFileRoute("/_authed")({
  beforeLoad: requireSignedIn,
});
