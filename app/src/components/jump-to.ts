import type { MouseEvent } from "react";

// A same-page jump (#371, reading-lite-e0l2; design spec, Keyboard, focus, and
// motion): scroll a target into view and move focus to it, without writing its
// hash into the URL or adding a history entry. The reading page's phone jump
// and the account page's section links share it. Smooth only under
// prefers-reduced-motion: no-preference, and asked for here rather than by a
// page-wide scroll-behavior rule, which would also animate the router's
// scroll-to-top on every route change.

/** Scroll to and focus a same-page target without writing its hash into the URL. */
export function jumpTo(event: MouseEvent<HTMLAnchorElement>, targetId: string): void {
  const target = document.getElementById(targetId);
  if (!target) return; // Let the browser follow the hash.
  event.preventDefault();
  target.scrollIntoView({ behavior: scrollBehaviour() });
  target.focus({ preventScroll: true });
}

/** Smooth only when motion is welcome. jsdom has no matchMedia; then it is instant. */
function scrollBehaviour(): ScrollBehavior {
  const welcome = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: no-preference)").matches;
  return welcome ? "smooth" : "auto";
}
