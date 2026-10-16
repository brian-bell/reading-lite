import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, type FocusEvent } from "react";
import type { CatalogSearch } from "../catalog";
import { LIBRARY_PAGE_SIZE, pageNumber, searchForPage, type LibrarySearch } from "../library-search";
import { focusPageHeading } from "./PageHeading";

export type PagedRoute = "/library" | "/catalog";

// Another page's link is never the current page. By default the router counts
// a route as active when its search is a subset, and marks Previous with
// aria-current.
export const PAGE_LINK_ACTIVE = { exact: true, includeSearch: true } as const;

type PagerProps = { offset: number; hasMore: boolean } & (
  | { to: "/library"; search: LibrarySearch }
  | { to: "/catalog"; search: CatalogSearch }
);

export function Pager({ to, search, offset, hasMore }: PagerProps) {
  const nav = useRef<HTMLElement>(null);
  const pageLabel = useRef<HTMLSpanElement>(null);
  const keepFocusInPager = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget === null && event.target.getAttribute("aria-disabled") === "true") {
      pageLabel.current?.focus();
    }
  };
  useLayoutEffect(
    () => () => {
      if (nav.current?.contains(document.activeElement)) focusPageHeading();
    },
    [],
  );

  return (
    <nav className="library-pager" aria-label="Pagination" onBlur={keepFocusInPager} ref={nav}>
      <PagerStep to={to} label="Previous" search={offset > 0 ? searchForPage(search, offset - LIBRARY_PAGE_SIZE) : null} />
      <span className="library-pager-page" ref={pageLabel} tabIndex={-1}>
        Page {pageNumber(offset)}
      </span>
      <PagerStep to={to} label="Next" search={hasMore ? searchForPage(search, offset + LIBRARY_PAGE_SIZE) : null} />
    </nav>
  );
}

function PagerStep({
  to,
  label,
  search,
}: {
  to: PagedRoute;
  label: string;
  search: LibrarySearch | null;
}) {
  const step = {
    search: search ?? {},
    disabled: search === null,
    activeOptions: PAGE_LINK_ACTIVE,
    preload: false as const,
    className: "button library-pager-step",
    children: label,
  };
  if (to === "/catalog") return <Link to="/catalog" {...step} />;
  return <Link to="/library" {...step} />;
}
