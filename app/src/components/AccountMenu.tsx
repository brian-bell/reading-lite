import { useLocation } from "@tanstack/react-router";
import { useRef, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

// Navigation account menu (design spec, Components: email, Account, Sign out),
// server-rendered from the whoami query. A <details> disclosure, so it opens
// before hydration. Signed out shows a sign-in link back to the current URL;
// while identity is unknown or unavailable, neither is shown. /login and
// sign-out land with #369, and the account page with Phase 5.

export type AccountState =
  | { status: "signed-in"; email: string }
  | { status: "signed-out" }
  | { status: "unknown" };

export function AccountArea({ account }: { account: AccountState }) {
  if (account.status === "signed-in") return <AccountMenu email={account.email} />;
  if (account.status === "signed-out") return <SignInLink />;
  return null;
}

function AccountMenu({ email }: { email: string }) {
  const details = useRef<HTMLDetailsElement>(null);

  function closeOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
    const menu = details.current;
    if (event.key !== "Escape" || !menu?.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
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
            <button type="button" disabled>
              Sign out
            </button>
          </li>
        </ul>
      </div>
    </details>
  );
}

function SignInLink() {
  const href = useLocation({ select: (location) => location.href });
  return (
    <a className="nav-item account-sign-in" href={`/login?next=${encodeURIComponent(href)}`}>
      <Icon name="user" size={22} />
      <span>Sign in</span>
    </a>
  );
}
