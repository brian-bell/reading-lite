import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { accountViewOf, type AccountRefusal } from "../account-state";
import { connectProviderKey, removeProviderKey } from "../api/provider";
import { isUnauthorized } from "../api/errors";
import { ACCOUNT_PROVIDER_PATH, stepUpLoginHref } from "../auth/return-path";
import { needsProviderKey, whoamiQueryKey, type Identity } from "../identity";
import {
  keyInputError,
  keyStateOf,
  type KeyConnectOutcome,
  type KeyState,
  type ProviderSettings,
} from "../provider";
import { useProviderStore } from "../provider-query";
import { expectedLayoutOf } from "../reading";
import { formatSessionTime } from "../sessions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { PendingLabel } from "./PendingLabel";
import { InlineNotice } from "./ReadingStates";
import { StepUpNotice } from "./StepUpNotice";

export const KEY_CONNECTED_SENTENCE = "Your key is connected. You can save readings now.";

const KEY_HEADING_ID = "provider-key-heading";
const STEP_UP_HREF = stepUpLoginHref(ACCOUNT_PROVIDER_PATH);

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

export function failureOf(error: unknown): Failure | undefined {
  if (error === null || error === undefined || isUnauthorized(error)) return undefined;
  const view = accountViewOf<never>({ data: undefined, error, fetchStatus: "idle" });
  return view.kind === "server-error" ? view : { kind: "offline" };
}

export function isRefusal(outcome: { kind: string }): outcome is AccountRefusal {
  return outcome.kind === "forbidden" || outcome.kind === "account-changed";
}

const KEY_STATUS: Record<KeyState["kind"], string> = {
  missing: "Not connected",
  removed: "Removed",
  connected: "Connected",
  invalid: "Key not accepted",
};

type KeyFieldError = "empty" | "malformed" | "invalid_key" | "model_access";

const KEY_FIELD_ERRORS: Record<KeyFieldError, string> = {
  empty: "Enter your OpenAI API key.",
  malformed: "Paste the whole key, with no spaces.",
  invalid_key: "OpenAI didn't accept this key. Check that you copied all of it, then try again.",
  model_access:
    "This key can't use the models Reading Lite needs. Allow them for the key's project in OpenAI, then try again.",
};

function keyFieldErrorOf(outcome: KeyConnectOutcome | undefined): KeyFieldError | null {
  if (outcome?.kind === "rejected") return outcome.reason;
  if (outcome?.kind === "invalid") return "malformed";
  return null;
}

export function ProviderKeySection({
  settings,
  next,
}: {
  settings: ProviderSettings;
  next: ReactNode;
}) {
  const queryClient = useQueryClient();
  const store = useProviderStore();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [checkError, setCheckError] = useState<"empty" | "malformed" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removedHere, setRemovedHere] = useState(false);
  const [firstKey, setFirstKey] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // The key on its way to the backend. Handed over here rather than as the
  // mutation's variables, which the mutation cache keeps after the request.
  const sending = useRef<string | null>(null);
  const state = keyStateOf(settings, removedHere);

  const connect = useMutation({
    mutationFn: () => {
      const key = sending.current ?? "";
      sending.current = null;
      return connectProviderKey(queryClient, key, expectedTenant);
    },
    networkMode: "always",
    retry: 0,
    onSuccess: async (outcome) => {
      if (isRefusal(outcome)) {
        store.refused(outcome);
        return;
      }
      if (outcome.kind !== "saved") return;
      setApiKey("");
      const cached = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
      if (needsProviderKey(cached) && (cached?.provider_key_provider ?? "openai") === "openai") {
        setFirstKey(true);
        // An in-flight whoami can land after this write and put the flag back.
        await queryClient.cancelQueries({ queryKey: whoamiQueryKey });
        queryClient.setQueryData<Identity | null>(whoamiQueryKey, (current) =>
          current ? { ...current, needs_provider_key: false, provider_key_provider: null } : current,
        );
      }
      setRemovedHere(false);
      store.saved(outcome.settings);
    },
  });

  const remove = useMutation({
    mutationFn: () => removeProviderKey(queryClient, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (isRefusal(outcome)) {
        store.refused(outcome);
        return;
      }
      if (outcome.kind !== "saved") return;
      setFirstKey(false);
      void queryClient.invalidateQueries({ queryKey: whoamiQueryKey });
      setRemovedHere(true);
      store.saved(outcome.settings);
    },
  });

  const busy = connect.isPending || remove.isPending;
  const fieldError = checkError ?? keyFieldErrorOf(connect.data);
  const connectFailure = failureOf(connect.error);
  const removeFailure = failureOf(remove.error);
  const stepUp = connect.data?.kind === "step-up" || remove.data?.kind === "step-up";

  useEffect(() => {
    if (fieldError !== null) inputRef.current?.focus();
  }, [fieldError, connect.data]);

  function submit() {
    if (busy) return;
    const problem = keyInputError(apiKey);
    setCheckError(problem);
    remove.reset();
    connect.reset();
    if (problem !== null) return;
    sending.current = apiKey.trim();
    connect.mutate();
  }

  function openRemove() {
    if (busy) return;
    connect.reset();
    remove.reset();
    setConfirmRemove(true);
  }

  const hasKey = state.kind === "connected" || state.kind === "invalid";
  return (
    <section className="account-section provider-card" aria-labelledby={KEY_HEADING_ID}>
      <div className="account-section-head">
        <div className="provider-name">
          <span className="provider-mark">
            <Icon name="sliders" size={22} />
          </span>
          <h2 id={KEY_HEADING_ID} className="account-section-title" tabIndex={-1}>
            OpenAI
          </h2>
        </div>
        <p className={`provider-status provider-status-${state.kind}`}>{KEY_STATUS[state.kind]}</p>
      </div>
      <dl className="provider-roles">
        <div>
          <dt>Summaries</dt>
          <dd>Main ideas and comparisons</dd>
        </div>
        <div>
          <dt>Embeddings</dt>
          <dd>Find related readings</dd>
        </div>
      </dl>
      <KeyStateText state={state} />
      {firstKey && state.kind === "connected" ? next : null}
      {connectFailure ? (
        <InlineNotice
          message={
            connectFailure.kind === "offline"
              ? "You're offline. Your key wasn't saved."
              : "Something went wrong on our side. Your key wasn't saved."
          }
          onAction={submit}
        >
          {connectFailure.kind === "server-error" ? <p className="form-hint">{connectFailure.message}</p> : null}
        </InlineNotice>
      ) : null}
      {removeFailure ? (
        <InlineNotice
          message={
            removeFailure.kind === "offline"
              ? "You're offline. Your key wasn't removed."
              : "Something went wrong on our side. Your key wasn't removed."
          }
          onAction={openRemove}
        >
          {removeFailure.kind === "server-error" ? <p className="form-hint">{removeFailure.message}</p> : null}
        </InlineNotice>
      ) : null}
      {stepUp ? (
        <StepUpNotice
          href={STEP_UP_HREF}
          lead={`Recent sign-in required. Your key wasn't ${remove.data?.kind === "step-up" ? "removed" : "saved"}.`}
        />
      ) : null}
      {connect.data?.kind === "provider-unavailable" ? (
        <p className="form-error" role="alert">
          We couldn't reach OpenAI to check your key, so it wasn't saved. Try again in a moment.
        </p>
      ) : null}
      <form
        className="provider-key-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor={`${id}-key`}>
            {hasKey ? "New API key" : "API key"}
          </label>
          <input
            id={`${id}-key`}
            ref={inputRef}
            className="text-input"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setCheckError(null);
            }}
            aria-invalid={fieldError !== null ? true : undefined}
            aria-describedby={fieldError !== null ? `${id}-key-error` : `${id}-key-hint`}
          />
          {fieldError !== null ? (
            <p id={`${id}-key-error`} className="field-error">
              {KEY_FIELD_ERRORS[fieldError]}
            </p>
          ) : (
            <p id={`${id}-key-hint`} className="form-hint">
              Reading Lite checks the key with OpenAI before saving it.
            </p>
          )}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            <PendingLabel
              label={hasKey ? "Replace key" : "Connect key"}
              pending="Checking key…"
              isPending={connect.isPending}
            />
          </button>
          {hasKey ? (
            <button type="button" className="button" ref={removeRef} onClick={openRemove} disabled={busy}>
              <PendingLabel label="Remove key…" pending="Removing…" isPending={remove.isPending} />
            </button>
          ) : null}
        </div>
      </form>
      <p className="provider-text">
        <strong>You pay your AI provider.</strong> Summaries and embeddings made with your key are billed to your
        OpenAI account. Reading Lite's hosting limits, such as how many readings you can save, are separate and
        don't change with your key.
      </p>
      <p className="provider-text">
        Your key is stored encrypted and decrypted on the server only to process your readings. This page shows
        only its last four characters, and never keeps it in your browser.
      </p>
      {confirmRemove ? (
        <ConfirmDialog
          title="Remove your OpenAI key?"
          confirmLabel="Remove key"
          onConfirm={() => {
            if (!busy) remove.mutate();
          }}
          onClose={() => setConfirmRemove(false)}
          returnFocus={() => removeRef.current}
        >
          <p>
            New summaries, novelty checks, and connections stop until you connect a key again. Your readings,
            their sources, and search stay as they are.
          </p>
          <p>Requests already sent to OpenAI may still finish and be charged to your OpenAI account.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function KeyStateText({ state }: { state: KeyState }) {
  switch (state.kind) {
    case "missing":
      return (
        <p className="provider-text">
          Connect your OpenAI API key to prepare summaries, assess novelty, and find connections for the readings
          you save.
        </p>
      );
    case "connected":
      return (
        <p className="provider-text">
          Key ending in <strong className="provider-last-four">{state.lastFour}</strong>
          {state.validatedAtMs !== null ? `, checked ${formatSessionTime(state.validatedAtMs)}` : null}.
        </p>
      );
    case "invalid":
      return (
        <p className="provider-text provider-text-warning">
          OpenAI no longer accepts the key ending in <strong className="provider-last-four">{state.lastFour}</strong>.
          Replace your key to resume summaries and connections.
        </p>
      );
    case "removed":
      return (
        <div className="provider-removed">
          <p className="provider-text">
            Your key was removed. Your readings, their sources, and search stay as they are. New summaries,
            novelty checks, and connections wait until you connect a key.
          </p>
          <p className="provider-text">
            Requests already sent to OpenAI may still finish and be charged to your OpenAI account.
          </p>
        </div>
      );
  }
}
