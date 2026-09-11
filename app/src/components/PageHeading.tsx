import { useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

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

export function focusPageHeading(): void {
  document.querySelector<HTMLElement>("#main h1")?.focus();
}

export function useFocusHeadingOnNavigation(): void {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onRendered", (event) => {
        if (event.fromLocation && event.pathChanged) focusPageHeading();
      }),
    [router],
  );
}
