import { useRouterState, type ParsedLocation } from "@tanstack/react-router";

/**
 * Something read from the page that is actually on screen.
 *
 * The router publishes the destination as `location` before its loader runs,
 * so while a navigation is in flight the page being left would otherwise read
 * what is meant for the next one — the trail it has not arrived at, or the
 * expired-session page remounting and refetching the old one.
 * `resolvedLocation` is the page that is actually rendered.
 *
 * `select` must return a value that settles: a primitive, or a shared frozen
 * constant. A fresh object each call is a snapshot React refuses during a
 * server render and re-renders endlessly on in the browser.
 */
export function useRenderedLocation<T>(select: (location: ParsedLocation) => T): T {
  // useRouterState validates what a selector returns against its structural
  // sharing option, which it cannot do for a selector this generic; the value
  // is whatever `select` returned, so the cast is the whole of the difference.
  const selectState = (state: { resolvedLocation?: ParsedLocation; location: ParsedLocation }) =>
    select(state.resolvedLocation ?? state.location);
  return useRouterState({ select: selectState } as never) as T;
}
