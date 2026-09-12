import { useLocation } from "@tanstack/react-router";
import { useRef, useState, type KeyboardEvent } from "react";
import { loginHref } from "../auth/return-path";
import type { SignOutResult } from "../auth/session";
import { Icon } from "./Icon";

// Navigation account menu (design spec, Components: email, Account, Sign out),
// server-rendered from the whoami query. A <details> disclosure, so it opens
// before hydration. Signed out shows a sign-in link back to the current URL,
// except on the sign-in pages themselves; while identity is unknown or
// unavailable, neither is shown. The account page lands with Phase 5.

export type AccountState =
  | { status: "signed-in"; email: string }
  | { status: "signed-out" }
  | { status: "unknown" };

const SIGN_IN_PATHS = new Set(["/login", "/login/verify", "/auth/verify"]);

export function AccountArea({
  account,
  onSignOut,
}: {
  account: AccountState;
  onSignOut: () => Promise<SignOutResult>;
}) {
  if (account.status === "signed-in") return <AccountMenu email={account.email} onSignOut={onSignOut} />;
  if (account.status === "signed-out") return <SignInLink />;
  return null;
}

function AccountMenu({ email, onSignOut }: { email: string; onSignOut: () => Promise<SignOutResult> }) {
  const details = useRef<HTMLDetailsElement>(null);
  const here = useLocation({ select: (location) => location.href });
  const [signingOut, setSigningOut] = useState(false);
  const [outcome, setOutcome] = useState<SignOutResult | null>(null);

  function closeOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
    const menu = details.current;
    if (event.key !== "Escape" || !menu?.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }

  async function signOut() {
    setSigningOut(true);
    setOutcome(null);
    try {
      // Still signed in: the backend kept the session, so say so rather than
      // show a signed-out page over a session a reload would restore. Account
      // changed: another tab replaced the session, so nothing was revoked and
      // this tab is someone else now — name that instead of a failure.
      setOutcome(await onSignOut());
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <details
      ref={details}
      className="account-menu"
      aria-label={`Account menu, signed in as ${email}`}
      onKeyDown={closeOnEscape}
    >
      <summary className="nav-item">
        <Icon name="user" size={22} />
        <span>Account</span>
      </summary>
      <div className="account-menu-panel">
        <p className="account-menu-email">{email}</p>
        <ul className="account-menu-items">
          <li>
            <a href="/account/security">Account</a>
          </li>
          <li>
            <button type="button" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </li>
        </ul>
        {outcome === "still-signed-in" ? (
          <p className="account-menu-error" role="alert">
            Couldn’t sign out. You are still signed in.
          </p>
        ) : null}
        {outcome === "account-changed" ? (
          <div className="account-menu-error" role="alert">
            <p>Another tab signed in as a different account, so you weren’t signed out.</p>
            {/* A full load, so the page starts over as the account above. */}
            <a href={here}>Reload</a>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SignInLink() {
  const { pathname, href } = useLocation({ select: (location) => ({ pathname: location.pathname, href: location.href }) });
  if (SIGN_IN_PATHS.has(pathname)) return null;
  return (
    <a className="nav-item account-sign-in" href={loginHref(href)}>
      <Icon name="user" size={22} />
      <span>Sign in</span>
    </a>
  );
}
