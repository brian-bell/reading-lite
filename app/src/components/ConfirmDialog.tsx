import { useEffect, useId, useRef, type ReactNode } from "react";
import { focusPageHeading } from "./PageHeading";

// A confirmation before a costly action (design spec, Components: "Confirm
// dialog"; Keyboard, focus, and motion: "Dialogs are modal <dialog> elements;
// focus returns to the opening control"). The first use is Reprocess on a
// ready reading (#410); account deletion's typed confirmation is meant to
// build on it.
//
// The dialog exists only while it is open and is opened with `showModal()`, so
// the browser makes the rest of the page inert, traps focus, and closes it on
// Escape. Every way it closes — Escape, Cancel, or Confirm — ends in the
// native `close` event, whose `returnValue` says which (`CONFIRM` only for
// Confirm), and focus is put back on `returnFocus()` there rather than left to
// the browser, which restores it only for some of those paths.
//
// Initial focus is Cancel, set after `showModal()`: a paid action is never one
// Enter away. React's `autoFocus` would not do it, because React focuses at
// commit, before the effect has opened the dialog.
//
// If the owner unmounts it while it is still open — the page behind it
// replaced by a refetch — no `close` event fires and the element that had
// focus is gone, so focus goes to the page heading, as a replaced page state
// does (PageHeading.tsx).

const CONFIRM = "confirm";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Called once, after the dialog has closed and focus has returned. */
  onConfirm: () => void;
  /** Called on every close, confirmed or not; the owner unmounts the dialog. */
  onClose: () => void;
  /** The control to give focus back to, read when the dialog closes. */
  returnFocus: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (!dialog.open) return;
      // Removed while open: after this commit the new page is in the DOM.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) focusPageHeading();
      });
    };
  }, []);

  function handleClose() {
    const dialog = ref.current;
    returnFocus()?.focus();
    onClose();
    if (dialog?.returnValue === CONFIRM) onConfirm();
  }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={handleClose}
    >
      <h2 className="confirm-dialog-title" id={titleId}>
        {title}
      </h2>
      <div className="confirm-dialog-body" id={bodyId}>
        {children}
      </div>
      <div className="confirm-dialog-actions">
        <button type="button" className="button" ref={cancelRef} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={() => ref.current?.close(CONFIRM)}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
