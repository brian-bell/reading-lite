import { useId, useRef, useState } from "react";
import {
  firstProblemField,
  markdownImportProblems,
  reprocessMarkdownBody,
  type MarkdownImportProblems,
  type MarkdownImportValues,
  type ReprocessMarkdownBody,
} from "../import-markdown";
import type { Reading } from "../reading";
import { MarkdownImportForm, type MarkdownImportFormHandle } from "./MarkdownImportForm";
import { useModalDialog } from "./modal-dialog";
import { ReprocessNoticeBanner, reprocessNoticeSentence } from "./ReprocessNotice";
import type { ReprocessAnswer, ReprocessNotice } from "./use-reprocess";

// Import a copy (#411; acceptance matrix, Actions: Reprocess from Markdown):
// the reader supplies the Markdown for a reading the Worker could not read —
// a failed one, or a ready one whose source was never captured — and it is
// reprocessed in place from that. The Markdown form from /save
// (MarkdownImportForm.tsx), with the source URL fixed to the reading's own,
// in a modal (modal-dialog.ts) opened from the status card or the Source view.
//
// The form's rules are /save's (import-markdown.ts), the size rule above all:
// a paste too large for the queue is refused before it is sent, in the field.
// The source URL is the reading's, which the reader cannot change, so its rule
// is the backend's to apply.
//
// An import that starts closes the dialog; the reading's refetch shows the
// attempt and its watch starts. One that does not start says why here, over
// the form, and keeps everything typed — the Markdown lives in this dialog's
// state and nowhere else, never browser storage. Cancel or Escape discards it.
//
// The page's own polite region is outside the modal, which the browser has
// made inert, so the dialog has its own.

export function ImportCopyDialog({
  reading,
  onImport,
  sending,
  onClose,
  returnFocus,
}: {
  reading: Reading;
  /** Sends the copy (use-reprocess.ts); the answer, or nothing when there is nothing to say. */
  onImport: (body: ReprocessMarkdownBody) => Promise<ReprocessAnswer | undefined>;
  /** A reprocess request is in flight. */
  sending: boolean;
  /** Called on every close; the owner unmounts the dialog. */
  onClose: () => void;
  /** The control to give focus back to, read when the dialog closes. */
  returnFocus: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<MarkdownImportFormHandle>(null);
  const titleId = useId();
  const bodyId = useId();
  const [values, setValues] = useState<MarkdownImportValues>({ sourceUrl: reading.url, title: "", markdown: "" });
  const [problems, setProblems] = useState<MarkdownImportProblems>({});
  const [notice, setNotice] = useState<ReprocessNotice | null>(null);
  // Emptied when the reader asks again, so the same refusal twice is said twice.
  const [said, setSaid] = useState<string | null>(null);

  // The Markdown is what the reader came to give; the source URL is fixed.
  useModalDialog(ref, () => {
    const dialog = ref.current;
    return dialog?.querySelector<HTMLTextAreaElement>("textarea[name=markdown]");
  });

  function close() {
    ref.current?.close();
  }

  function handleClose() {
    returnFocus()?.focus();
    onClose();
  }

  function submit() {
    if (sending) return;
    setNotice(null);
    setSaid(null);
    // The source URL's rule is left to the backend: the reader cannot change it.
    const { sourceUrl: _, ...refused } = markdownImportProblems(values);
    setProblems(refused);
    const first = firstProblemField(refused);
    if (first) {
      formRef.current?.focus(first);
      return;
    }
    void onImport(reprocessMarkdownBody(values)).then((answer) => {
      if (answer === undefined) return;
      if (answer.kind === "started" || answer.kind === "not-found") {
        close();
        return;
      }
      setNotice(answer);
      setSaid(reprocessNoticeSentence(answer, "import"));
    });
  }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog import-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // A request in flight is not abandoned by Escape: its answer is said
      // here, and the reader's paste would be gone with the dialog.
      onCancel={(event) => {
        if (sending) event.preventDefault();
      }}
      onClose={handleClose}
    >
      <h2 className="confirm-dialog-title" id={titleId}>
        Import a copy
      </h2>
      <div className="confirm-dialog-body" id={bodyId}>
        <p>
          {reading.status === "ready"
            ? "Paste the article as Markdown. This reading is processed again from your copy, replacing its summary and connections; if that fails, the current version stays."
            : "Paste the article as Markdown. This reading is processed from your copy instead of the page."}
        </p>
      </div>
      {notice ? <ReprocessNoticeBanner notice={notice} request="import" onTryAgain={submit} /> : null}
      <MarkdownImportForm
        ref={formRef}
        values={values}
        problems={problems}
        onChange={setValues}
        onSubmit={submit}
        pending={sending}
        sourceUrlReadOnly
      >
        <button
          type="button"
          className="button"
          aria-disabled={sending || undefined}
          onClick={() => {
            if (!sending) close();
          }}
        >
          Cancel
        </button>
      </MarkdownImportForm>
      {/* Always here, so a change to its text is announced. */}
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </dialog>
  );
}
