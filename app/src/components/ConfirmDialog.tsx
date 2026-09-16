import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

// A confirmation before a costly action (design spec, Components: "Confirm
// dialog"; Keyboard, focus, and motion: "Dialogs are modal <dialog> elements;
// focus returns to the opening control"). The first use is Reprocess on a
// ready reading (#410); account deletion's typed confirmation is meant to
// build on it.
//
// The dialog exists only while it is open and is opened with `showModal()`, so
// the browser makes the rest of the page inert, traps focus, and closes it on
// Escape. Every way it closes — Escape, Cancel, or Confirm — ends in the
// native `close` event, and focus is put back on `returnFocus` there rather
// than left to the browser, which restores it only for some of those paths.
// Initial focus is Cancel: a paid action is never one Enter away.

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
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  function handleClose() {
    returnFocus.current?.focus();
    onClose();
    if (confirmed.current) {
      confirmed.current = false;
      onConfirm();
    }
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
        <button type="button" className="button" autoFocus onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            confirmed.current = true;
            ref.current?.close();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
