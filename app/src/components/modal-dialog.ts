import { useEffect, type RefObject } from "react";
import { focusPageHeading } from "./PageHeading";

// What every modal on this app does (design spec, Keyboard, focus, and motion:
// "Dialogs are modal <dialog> elements; focus returns to the opening
// control"): the Reprocess confirmation and account deletion (ConfirmDialog.tsx)
// and Import a copy (ImportCopyDialog.tsx).
//
// The dialog exists only while it is open and is opened with `showModal()`, so
// the browser makes the rest of the page inert, traps focus, and closes it on
// Escape. Every way it closes ends in the native `close` event, and the owner
// puts focus back on the opening control there rather than leaving it to the
// browser, which restores it only for some of those paths.
//
// Initial focus is set after `showModal()`: React's `autoFocus` would not do
// it, because React focuses at commit, before the effect has opened the
// dialog.
//
// If the owner unmounts it while it is still open — the page behind it
// replaced by a refetch — no `close` event fires and the element that had
// focus is gone, so focus goes to the page heading, as a replaced page state
// does (PageHeading.tsx).

export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  initialFocus: () => HTMLElement | null | undefined,
) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    initialFocus()?.focus();
    return () => {
      if (!dialog.open) return;
      // Removed while open: after this commit the new page is in the DOM.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) focusPageHeading();
      });
    };
    // Once, when the dialog opens.
  }, []);
}
