import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { accountViewOf, readRefusedBy, type AccountRefusal, type AccountView } from "../account-state";
import { connectProviderKey, removeProviderKey, saveProviderPreferences } from "../api/provider";
import { isUnauthorized } from "../api/errors";
import { ACCOUNT_PROVIDER_PATH, stepUpLoginHref } from "../auth/return-path";
import { whoamiQueryKey, type Identity } from "../identity";
import {
  capFromDollars,
  dollarsOf,
  formatUsd,
  keyInputError,
  keyStateOf,
  providerQueryKey,
  providerUsageQueryKey,
  type CapInput,
  type Effort,
  type KeyConnectOutcome,
  type KeyState,
  type PreferencesSaveOutcome,
  type ProviderResult,
  type ProviderSettings,
  type ProviderUsage,
} from "../provider";
import { providerQueryOptions, providerUsageQueryOptions } from "../provider-query";
import { expectedLayoutOf } from "../reading";
import { formatSessionTime } from "../sessions";
import { BackToLibrary } from "./BackToLibrary";
import { ConfirmDialog } from "./ConfirmDialog";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { PendingLabel } from "./PendingLabel";
import {
  AccountChanged,
  Forbidden,
  InlineNotice,
  LoadingRegion,
  OfflineNotice,
  ServerError,
} from "./ReadingStates";
import { StepUpNotice } from "./StepUpNotice";

// The provider page (reading-lite-gh341.8; ADR 0004). The reader's own OpenAI
// key — connect, replace, and remove — then the summary effort, and the daily
// spending limit with today's charges. Fetched in the browser only, like the
// account page (ADR 0003).
//
// The key is in the field's own state and the connect request's body, and
// nowhere else: never browser storage, and the field is emptied once the
// backend has it. The backend checks a key with OpenAI before storing it, so
// OpenAI's refusal is the field's error, not the page's. Connect, replace,
// and remove need a sign-in from the last ten minutes; that refusal is the
// fresh sign-in link, which comes back here (auth/return-path.ts). Effort and
// the limit do not need one.
//
// The backend has no removed state: a removed key is no key. A removal made
// on this visit says what it changed — the library, sources, and search stay
// — and the confirmation before it says that requests already sent may still
// finish and be charged.
//
// A 403 or 412 from any read or write is the whole page's state, as it is on
// the account page; a failed write stays in its own section.

const KEY_HEADING_ID = "provider-key-heading";
const EFFORT_HEADING_ID = "provider-effort-heading";
const SPENDING_HEADING_ID = "provider-spending-heading";

const STEP_UP_HREF = stepUpLoginHref(ACCOUNT_PROVIDER_PATH);

const EFFORT_OPTIONS: readonly { value: Effort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (default)" },
];

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

/** How a write that threw reads: offline, or the retryable server error. A 401 is the shell's page. */
function failureOf(error: unknown): Failure | undefined {
  if (error === null || error === undefined || isUnauthorized(error)) return undefined;
  const view = accountViewOf<never>({ data: undefined, error, fetchStatus: "idle" });
  return view.kind === "server-error" ? view : { kind: "offline" };
}

type PageView =
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "server-error"; message: string }
  | { kind: "loading" }
  | { kind: "offline"; settings?: ProviderSettings }
  | { kind: "ready"; settings: ProviderSettings };

/** A refusal from either read is the page's; so is a failed settings read. */
function pageViewOf(settings: AccountView<ProviderSettings>, usage: AccountView<ProviderUsage>): PageView {
  for (const view of [settings, usage]) {
    if (view.kind === "forbidden") return { kind: "forbidden" };
  }
  for (const view of [settings, usage]) {
    if (view.kind === "account-changed") return view;
  }
  if (settings.kind === "offline") {
    return settings.value === undefined ? { kind: "offline" } : { kind: "offline", settings: settings.value };
  }
  if (settings.kind === "ready") return { kind: "ready", settings: settings.value };
  return settings;
}

export function ProviderPage() {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const settingsQuery = useQuery(providerQueryOptions(queryClient, identity));
  const usageQuery = useQuery(providerUsageQueryOptions(queryClient, identity));
  // A removal on this visit, so the page can say what it changed.
  const [removedHere, setRemovedHere] = useState(false);

  const settingsView = accountViewOf({
    data: settingsQuery.data,
    error: settingsQuery.error,
    fetchStatus: settingsQuery.fetchStatus,
  });
  const usageView = accountViewOf({
    data: usageQuery.data,
    error: usageQuery.error,
    fetchStatus: usageQuery.fetchStatus,
  });
  const view = pageViewOf(settingsView, usageView);
  const retry = () => void settingsQuery.refetch();

  const store = useStore(queryClient, identity);

  switch (view.kind) {
    case "forbidden":
      return (
        <PageStateFocus kind={view.kind}>
          <Forbidden>
            <div className="form-actions">
              <BackToLibrary className="button" />
            </div>
          </Forbidden>
        </PageStateFocus>
      );
    case "account-changed":
      return (
        <PageStateFocus kind={view.kind}>
          <AccountChanged actingTenant={view.actingTenant} />
        </PageStateFocus>
      );
    case "server-error":
      return (
        <PageStateFocus kind={view.kind}>
          <ServerError message={view.message} onRetry={retry} />
        </PageStateFocus>
      );
  }
  const settings = view.kind === "ready" || view.kind === "offline" ? view.settings : undefined;
  return (
    <PageStateFocus kind="sections">
      <div className="page account-page provider-page">
        <PageHeading>Provider</PageHeading>
        <p className="provider-intro">
          Connect an AI provider to prepare summaries, assess novelty, and find connections. Reading your saved
          library does not need an active key.
        </p>
        {view.kind === "loading" ? <LoadingRegion /> : null}
        {view.kind === "offline" ? <OfflineNotice onRetry={retry} /> : null}
        {settings ? (
          <div className="account-sections">
            <KeySection
              settings={settings}
              removedHere={removedHere}
              onSaved={(next, removed) => {
                setRemovedHere(removed);
                store.saved(next);
              }}
              onRefused={store.refused}
            />
            <EffortSection settings={settings} onSaved={store.saved} onRefused={store.refused} />
            <SpendingSection
              settings={settings}
              usage={usageView}
              onRetryUsage={() => void usageQuery.refetch()}
              onSaved={store.saved}
              onRefused={store.refused}
            />
          </div>
        ) : null}
      </div>
    </PageStateFocus>
  );
}

/**
 * A write's answer, stored as the read's: new settings, or a refusal the page
 * then shows as a refused read would. New settings may move the limit, so
 * today's usage is read again.
 */
function useStore(queryClient: QueryClient, identity: Identity | null | undefined) {
  const userId = identity?.user_id ?? "";
  return {
    saved(settings: ProviderSettings) {
      const stored: ProviderResult = { state: "ready", value: settings };
      queryClient.setQueryData<ProviderResult>(providerQueryKey(userId), stored);
      void queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(userId) });
    },
    refused(refusal: AccountRefusal) {
      queryClient.setQueryData<ProviderResult>(providerQueryKey(userId), readRefusedBy(refusal));
    },
  };
}

interface SectionProps {
  settings: ProviderSettings;
  onSaved: (settings: ProviderSettings) => void;
  onRefused: (refusal: AccountRefusal) => void;
}

function isRefusal(outcome: { kind: string }): outcome is AccountRefusal {
  return outcome.kind === "forbidden" || outcome.kind === "account-changed";
}

const KEY_STATUS: Record<KeyState["kind"], string> = {
  missing: "Not connected",
  removed: "Removed",
  connected: "Connected",
  invalid: "Key not accepted",
};

/** What the key field says under itself, from the check before the request or OpenAI's answer. */
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

function KeySection({
  settings,
  removedHere,
  onSaved,
  onRefused,
}: Omit<SectionProps, "onSaved"> & {
  removedHere: boolean;
  onSaved: (settings: ProviderSettings, removed: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [checkError, setCheckError] = useState<"empty" | "malformed" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const state = keyStateOf(settings, removedHere);

  const connect = useMutation({
    mutationFn: (key: string) => connectProviderKey(queryClient, key, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (isRefusal(outcome)) {
        onRefused(outcome);
        return;
      }
      if (outcome.kind !== "saved") return;
      setApiKey("");
      onSaved(outcome.settings, false);
    },
  });

  const remove = useMutation({
    mutationFn: () => removeProviderKey(queryClient, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (isRefusal(outcome)) {
        onRefused(outcome);
        return;
      }
      if (outcome.kind === "saved") onSaved(outcome.settings, true);
    },
  });

  const busy = connect.isPending || remove.isPending;
  const fieldError = checkError ?? keyFieldErrorOf(connect.data);
  const connectFailure = failureOf(connect.error);
  const removeFailure = failureOf(remove.error);
  const stepUp = connect.data?.kind === "step-up" || remove.data?.kind === "step-up";

  // Acceptance matrix, Invalid input: the reason under the field, and focus on it.
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
    connect.mutate(apiKey.trim());
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
        <h2 id={KEY_HEADING_ID} className="account-section-title" tabIndex={-1}>
          OpenAI
        </h2>
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

/** A preferences save's failure: thrown (offline, server) or refused as invalid. */
function saveFailureMessage(failure: Failure, what: string): string {
  return failure.kind === "offline"
    ? `You're offline. ${what} wasn't saved.`
    : `Something went wrong on our side. ${what} wasn't saved.`;
}

function usePreferencesSave({ onSaved, onRefused }: Omit<SectionProps, "settings">) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  return useMutation({
    mutationFn: (body: Parameters<typeof saveProviderPreferences>[1]): Promise<PreferencesSaveOutcome> =>
      saveProviderPreferences(queryClient, body, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (isRefusal(outcome)) onRefused(outcome);
      else if (outcome.kind === "saved") onSaved(outcome.settings);
    },
  });
}

/**
 * Effort, saved as it changes, as the notification settings are. While a
 * save is in flight, or after one failed, the choice shows what the reader
 * asked for rather than snapping back.
 */
function EffortSection({ settings, onSaved, onRefused }: SectionProps) {
  const id = useId();
  const save = usePreferencesSave({ onSaved, onRefused });
  const failure = failureOf(save.error);
  const unsaved = save.isPending || failure !== undefined ? save.variables?.effort : undefined;
  const shown = unsaved ?? settings.effort;
  return (
    <section className="account-section" aria-labelledby={EFFORT_HEADING_ID}>
      <h2 id={EFFORT_HEADING_ID} className="account-section-title" tabIndex={-1}>
        Summary effort
      </h2>
      <p className="provider-text">
        How hard the model works on each summary. Higher effort gives more careful summaries and costs more per
        reading. A change applies to readings processed after it.
      </p>
      {failure ? (
        <InlineNotice
          message={saveFailureMessage(failure, "Your change")}
          onAction={() => {
            if (save.variables !== undefined) save.mutate(save.variables);
          }}
        >
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
          <button type="button" className="button" onClick={() => save.reset()}>
            Discard
          </button>
        </InlineNotice>
      ) : null}
      {save.data?.kind === "invalid" ? (
        <p className="form-error" role="alert">
          Your change wasn't saved. Choose low, medium, or high.
        </p>
      ) : null}
      <div className="field provider-effort-field">
        <label className="field-label" htmlFor={`${id}-effort`}>
          Effort
        </label>
        <select
          id={`${id}-effort`}
          className="text-input"
          value={shown}
          disabled={save.isPending}
          onChange={(event) => {
            save.reset();
            save.mutate({ effort: event.currentTarget.value as Effort });
          }}
        >
          {EFFORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

type CapFieldError = Exclude<CapInput["kind"], "cap">;

function capErrorText(error: CapFieldError, operatorMicrodollars: number): string {
  if (error === "zero") return "Enter an amount more than $0.";
  if (error === "above") {
    return `Your limit can't be higher than Reading Lite's daily limit of ${formatUsd(operatorMicrodollars)}.`;
  }
  return "Enter an amount in dollars, like 1.50.";
}

/**
 * The reader's daily limit, which may only be lower than Reading Lite's own,
 * and today's charges against it. Charges come from the spend guard and can
 * be missing on their own; the limit still saves without them.
 */
function SpendingSection({
  settings,
  usage,
  onRetryUsage,
  onSaved,
  onRefused,
}: SectionProps & { usage: AccountView<ProviderUsage>; onRetryUsage: () => void }) {
  const id = useId();
  const save = usePreferencesSave({ onSaved, onRefused });
  const own = settings.daily_spend_cap_microdollars;
  const operator = settings.operator_daily_spend_microdollars;
  const [text, setText] = useState(() => dollarsOf(settings.effective_daily_spend_microdollars));
  const [checkError, setCheckError] = useState<CapFieldError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The stored limit moved (a save here, or a read after one elsewhere): the
  // field starts from it again.
  const effective = settings.effective_daily_spend_microdollars;
  useEffect(() => setText(dollarsOf(effective)), [effective]);

  const fieldError: CapFieldError | null =
    checkError ?? (save.data?.kind === "cap-above" ? "above" : save.data?.kind === "invalid" ? "invalid" : null);
  const failure = failureOf(save.error);

  useEffect(() => {
    if (fieldError !== null) inputRef.current?.focus();
  }, [fieldError, save.data]);

  function submit() {
    if (save.isPending) return;
    const cap = capFromDollars(text, operator);
    save.reset();
    if (cap.kind !== "cap") {
      setCheckError(cap.kind);
      return;
    }
    setCheckError(null);
    save.mutate({ daily_spend_cap_microdollars: cap.microdollars });
  }

  function useDefault() {
    if (save.isPending) return;
    setCheckError(null);
    save.reset();
    save.mutate({ daily_spend_cap_microdollars: null });
  }

  const saved = save.data?.kind === "saved";
  return (
    <section className="account-section" aria-labelledby={SPENDING_HEADING_ID}>
      <h2 id={SPENDING_HEADING_ID} className="account-section-title" tabIndex={-1}>
        Daily spending limit
      </h2>
      <UsageLine usage={usage} onRetry={onRetryUsage} />
      <p className="provider-text">
        Reading Lite stops sending requests with your key for the day once charges reach your limit. Charges count
        requests still running at their most, so they can read higher than your OpenAI bill.
      </p>
      {failure ? (
        <InlineNotice message={saveFailureMessage(failure, "Your limit")} onAction={submit}>
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
        </InlineNotice>
      ) : null}
      <form
        className="provider-cap-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor={`${id}-cap`}>
            Daily limit in US dollars
          </label>
          <input
            id={`${id}-cap`}
            ref={inputRef}
            className="text-input provider-cap-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setCheckError(null);
              if (save.data !== undefined) save.reset();
            }}
            aria-invalid={fieldError !== null ? true : undefined}
            aria-describedby={fieldError !== null ? `${id}-cap-error` : `${id}-cap-hint`}
          />
          {fieldError !== null ? (
            <p id={`${id}-cap-error`} className="field-error">
              {capErrorText(fieldError, operator)}
            </p>
          ) : (
            <p id={`${id}-cap-hint`} className="form-hint">
              Up to Reading Lite's daily limit of {formatUsd(operator)}. Resets at midnight UTC.
            </p>
          )}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            Save limit
          </button>
          {own !== null ? (
            <button type="button" className="button" onClick={useDefault} disabled={save.isPending}>
              Use Reading Lite's limit
            </button>
          ) : null}
        </div>
      </form>
      {/* Always in the page, so the confirmation is announced when it arrives. */}
      <p className="form-status" role="status">
        {saved ? `Daily limit saved: ${formatUsd(effective)}.` : null}
      </p>
    </section>
  );
}

function UsageLine({ usage, onRetry }: { usage: AccountView<ProviderUsage>; onRetry: () => void }) {
  switch (usage.kind) {
    case "loading":
      return <LoadingRegion className="provider-usage" />;
    case "server-error":
      return <InlineNotice message="Today's charges aren't available right now." onAction={onRetry} />;
    case "ready":
    case "offline":
      if (usage.value === undefined) return null;
      return (
        <p className="provider-usage">
          Today: <strong>{formatUsd(usage.value.charged_microdollars)}</strong> of your{" "}
          {formatUsd(usage.value.effective_daily_spend_microdollars)} limit. Resets{" "}
          {formatSessionTime(usage.value.reset_at_ms)}.
        </p>
      );
    default:
      // A refusal is the page's (pageViewOf).
      return null;
  }
}
