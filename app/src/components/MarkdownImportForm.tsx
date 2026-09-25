import { useImperativeHandle, useRef, type ChangeEvent, type FormEvent, type Ref } from "react";
import type { MarkdownImportField, MarkdownImportProblems, MarkdownImportValues } from "../import-markdown";
import { Icon } from "./Icon";
import { TextField } from "./TextField";

// The Markdown capture form (#408): source URL, optional title, and the
// Markdown itself. Controlled: the values and their problems are the caller's
// state, so /save keeps a paste across a tab switch and a refusal, and the
// reading page's "Import a copy" (#411) can prefill the source URL and fix it
// read-only. The caller runs the rules (import-markdown.ts) and the request;
// this renders the fields, links each problem to its field (TextField), and
// moves focus where the caller asks.
//
// The Markdown lives in that state and nowhere else: the page's memory while
// it is open, never browser storage.

export interface MarkdownImportFormHandle {
  focus(field: MarkdownImportField): void;
}

export function MarkdownImportForm({
  ref,
  values,
  problems,
  onChange,
  onSubmit,
  pending,
  sourceUrlReadOnly = false,
}: {
  ref?: Ref<MarkdownImportFormHandle>;
  values: MarkdownImportValues;
  problems: MarkdownImportProblems;
  /**
   * An update to apply to the values as they are when it lands, not as they
   * were at this render: two changes before a re-render (an autofill filling
   * two fields) each keep the other's. A useState setter fits as it is.
   */
  onChange: (update: (previous: MarkdownImportValues) => MarkdownImportValues) => void;
  onSubmit: () => void;
  pending: boolean;
  /** The reading's own URL, which a copy imported over it cannot change (#411). */
  sourceUrlReadOnly?: boolean;
}) {
  const sourceUrlRef = useRef<HTMLInputElement>(null);
  const markdownRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus(field) {
      (field === "sourceUrl" ? sourceUrlRef : markdownRef).current?.focus();
    },
  }));

  /** The change handler for one field: read the value now, apply it to whatever the values are then. */
  function change(field: keyof MarkdownImportValues) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      onChange((previous) => ({ ...previous, [field]: value }));
    };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    // The browser's own checks would replace our messages with its bubbles,
    // which are neither in the page nor linked to the field.
    <form className="save-form" onSubmit={submit} noValidate>
      <TextField label="Source URL" problem={problems.sourceUrl}>
        {(control) => (
          <input
            {...control}
            ref={sourceUrlRef}
            className="text-input"
            type="text"
            inputMode="url"
            name="source_url"
            autoComplete="url"
            spellCheck={false}
            readOnly={sourceUrlReadOnly}
            value={values.sourceUrl}
            onChange={change("sourceUrl")}
          />
        )}
      </TextField>
      <TextField label="Title (optional)">
        {(control) => (
          <input
            {...control}
            className="text-input"
            type="text"
            name="title"
            autoComplete="off"
            value={values.title}
            onChange={change("title")}
          />
        )}
      </TextField>
      <TextField label="Markdown" problem={problems.markdown}>
        {(control) => (
          <textarea
            {...control}
            ref={markdownRef}
            className="text-input text-area"
            name="markdown"
            rows={12}
            spellCheck={false}
            value={values.markdown}
            onChange={change("markdown")}
          />
        )}
      </TextField>
      <div className="form-actions">
        {/* aria-disabled, not disabled, for the reason the URL form gives
            (SavePage.tsx): the reader keeps their place while it runs. */}
        <button type="submit" className="button button-primary button-leading-icon" aria-disabled={pending || undefined}>
          <Icon name="plus" size={16} strokeWidth={2} />
          Import
        </button>
      </div>
    </form>
  );
}
