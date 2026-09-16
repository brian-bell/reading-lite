import { useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

// Design spec, Keyboard, focus, and motion: after a route change, focus the
// page heading (tabindex="-1") so screen readers announce the new page. Not on
// the first load, and not when only the search changes (library filters keep
// focus in their own controls).

export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="page-title" tabIndex={-1}>
      {children}
    </h1>
  );
}

export function focusPageHeading(options?: FocusOptions): void {
  document.querySelector<HTMLElement>("#main h1")?.focus(options);
}

export function useFocusHeadingOnNavigation(): void {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onRendered", (event) => {
        // Without scrolling: scroll restoration has already put the page where
        // it belongs — the top for a new page, the reader's place for Back or
        // "Back to library" (#407) — and focusing would scroll the heading
        // back into view.
        if (event.fromLocation && event.pathChanged) focusPageHeading({ preventScroll: true });
      }),
    [router],
  );
}

/**
 * Focus the new heading when one state of a page replaced another in place
 * (#416, #431). A page that replaces the one on screen takes the focus it
 * held — the heading a route change focused, or the Retry the reader pressed
 * on a state page — so the new state is announced rather than focus falling to
 * the top of the document. Only when focus was lost: a page that stays up
 * keeps the reader on the control they were on.
 *
 * `kind` names the state; `children` is the page rendered for it. The marker
 * below has to be the page's immediate sibling, under this one parent: React
 * processes a parent's deletions in child order, so a marker kept in a wrapper
 * of its own would have its cleanup run after the page's DOM was already gone,
 * and would only ever see the body.
 */
export function PageStateFocus({ kind, children }: { kind: string; children: ReactNode }) {
  const wasInPage = useRef(false);
  useEffect(() => {
    if (!wasInPage.current) return;
    wasInPage.current = false;
    if (document.activeElement?.closest(".page") == null) focusPageHeading();
  }, [kind]);
  return (
    <>
      <FocusWithin key={kind} flag={wasInPage} />
      {children}
    </>
  );
}

/**
 * Records, as the state changes, whether focus was inside the page then on
 * screen. Keyed on the state, so it is replaced with the page; it comes first,
 * so its layout cleanup runs before the page's DOM is removed and the focused
 * element is still there to ask.
 */
function FocusWithin({ flag }: { flag: RefObject<boolean> }) {
  useLayoutEffect(
    () => () => {
      flag.current = document.activeElement?.closest(".page") != null;
    },
    [flag],
  );
  return null;
}
