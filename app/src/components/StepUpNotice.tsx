import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { STEP_UP_LOGIN_HREF } from "../auth/return-path";

// A sensitive account change refused for want of a recent sign-in (the
// backend's `requireRecentAuth`: a magic-link sign-in from the last ten
// minutes). The link is the SPA's step-up: sign-in with the email locked, and
// back to /account/security once the new link is opened (auth/return-path.ts),
// or to `href`'s own page. Email change, API token create, account deletion,
// and the provider key all say it this way.

export function StepUpNotice({
  lead,
  className = "form-error",
  href = STEP_UP_LOGIN_HREF,
}: {
  lead?: ReactNode;
  className?: string;
  href?: string;
}) {
  return (
    <p className={className} role="alert">
      {lead}
      {lead ? " " : null}
      <Link to={href}>Request a fresh sign-in link</Link> to confirm a sensitive change.
    </p>
  );
}
