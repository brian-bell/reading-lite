import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { SignOutResult } from "../auth/session";
import type { ThemePreference } from "../theme";
import { AccountArea, type AccountState } from "./AccountMenu";
import { Icon } from "./Icon";
import { LegalFooter } from "./LegalPages";
import { ThemeControl } from "./ThemeControl";

export type { AccountState } from "./AccountMenu";

export function AppShell({
  theme,
  onThemeChange,
  account,
  onSignOut,
  children,
}: {
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  account: AccountState;
  onSignOut: () => Promise<SignOutResult>;
  children: ReactNode;
}) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {/* .shell is the size container; .shell-frame responds to it. */}
      <div className="shell">
        <div className="shell-frame">
          <header className="shell-nav">
            <Link to="/" className="brand" aria-label="Reading Lite home">
              <span className="brand-mark" aria-hidden="true">
                r.
              </span>
              <span className="brand-name" aria-hidden="true">
                reading lite
              </span>
            </Link>
            <nav aria-label="Main">
              <ul className="nav-items">
                <li>
                  <Link to="/" className="nav-item" activeOptions={{ exact: true, includeSearch: false }}>
                    <Icon name="desk" size={22} />
                    <span>Desk</span>
                  </Link>
                </li>
                <li>
                  <Link to="/library" className="nav-item" activeOptions={{ includeSearch: false }}>
                    <Icon name="library" size={22} />
                    <span>Library</span>
                  </Link>
                </li>
                <li>
                  <Link to="/threads" className="nav-item">
                    <Icon name="thread" size={22} />
                    <span>Threads</span>
                  </Link>
                </li>
                <li>
                  <Link to="/catalog" className="nav-item" activeOptions={{ includeSearch: false }}>
                    <Icon name="catalog" size={22} />
                    <span>Catalog</span>
                  </Link>
                </li>
                <li>
                  <Link to="/save" className="nav-item">
                    <Icon name="plus" size={22} />
                    {/* The column shows "Save"; the bar has room for the rest. */}
                    <span>
                      Save <span className="nav-item-rest">reading</span>
                    </span>
                  </Link>
                </li>
              </ul>
              <ThemeControl value={theme} onChange={onThemeChange} />
              <AccountArea account={account} onSignOut={onSignOut} />
            </nav>
          </header>
          <div className="shell-body">
            <main id="main" className="shell-main" tabIndex={-1}>
              {children}
            </main>
            <LegalFooter />
          </div>
        </div>
      </div>
    </>
  );
}
