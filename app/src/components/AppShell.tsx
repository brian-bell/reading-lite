import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ThemePreference } from "../theme";
import { Icon } from "./Icon";
import { ThemeControl } from "./ThemeControl";

// Connected navigation shell (design spec, Layout and Components): an 80 px
// column at desktop widths, a brand row plus horizontal bar at container width
// ≤650 px. The account menu joins the navigation with signed-in identity.
export function AppShell({
  theme,
  onThemeChange,
  children,
}: {
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
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
                    <Icon name="library" size={22} />
                    <span>Library</span>
                  </Link>
                </li>
                <li>
                  <Link to="/save" className="nav-item">
                    <Icon name="plus" size={22} />
                    <span>Save reading</span>
                  </Link>
                </li>
              </ul>
              <ThemeControl value={theme} onChange={onThemeChange} />
            </nav>
          </header>
          <main id="main" className="shell-main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
