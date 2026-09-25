import { useId, type ReactNode } from "react";

// One labelled field with its problem under it (#431, #408): the label, the
// control, and the message the control is described by while it is invalid.
// The control is the caller's — an input or a textarea with its own props —
// and takes the wiring this hands it, so every capture field links its error
// the same way and colour is never the only sign (app.css, .field-error).

export interface FieldControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export function TextField({
  label,
  problem,
  children,
}: {
  label: string;
  problem?: string | null;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const problemId = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": problem ? true : undefined,
        "aria-describedby": problem ? problemId : undefined,
      })}
      {problem ? (
        <p className="field-error" id={problemId}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}
