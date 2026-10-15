import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import { saveProviderPreferences } from "../api/provider";
import { whoamiQueryKey, type Identity } from "../identity";
import {
  capFromDollars,
  dollarsOf,
  formatUsd,
  type CapInput,
  type Effort,
  type PreferencesSaveOutcome,
  type ProviderSettings,
  type ProviderUsage,
} from "../provider";
import { providerQueryOptions, providerUsageQueryOptions, useProviderStore } from "../provider-query";
import { expectedLayoutOf } from "../reading";
import { formatSessionTime } from "../sessions";
import { BackToLibrary } from "./BackToLibrary";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { KEY_CONNECTED_SENTENCE, ProviderKeySection, failureOf, isRefusal } from "./ProviderKey";
import {
  AccountChanged,
  Forbidden,
  InlineNotice,
  LoadingRegion,
  OfflineNotice,
  ServerError,
} from "./ReadingStates";

// The provider page (reading-lite-gh341.8; ADR 0004). The OpenAI key is
// ProviderKeySection. This page adds the summary effort and the daily spending
// limit with today's charges. Fetched in the browser only, like the account
// page (ADR 0003). Effort and the limit do not need a recent sign-in.
//
// A 403 or 412 from any read or write is the whole page's state, as it is on
// the account page; a failed write stays in its own section.

const EFFORT_HEADING_ID = "provider-effort-heading";
const SPENDING_HEADING_ID = "provider-spending-heading";

const EFFORT_OPTIONS: readonly { value: Effort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (default)" },
];

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
            <ProviderKeySection settings={settings} next={<FirstKeyNextStep />} />
            <EffortSection settings={settings} />
            <SpendingSection
              settings={settings}
              usage={usageView}
              onRetryUsage={() => void usageQuery.refetch()}
            />
          </div>
        ) : null}
      </div>
    </PageStateFocus>
  );
}

function FirstKeyNextStep() {
  return (
    <aside className="callout callout-enter" aria-label="Next step">
      <p>{KEY_CONNECTED_SENTENCE}</p>
      <Link to="/save" className="button button-primary">
        Save a reading
      </Link>
    </aside>
  );
}

/** A preferences save's failure: thrown (offline, server) or refused as invalid. */
function saveFailureMessage(failure: NonNullable<ReturnType<typeof failureOf>>, what: string): string {
  return failure.kind === "offline"
    ? `You're offline. ${what} wasn't saved.`
    : `Something went wrong on our side. ${what} wasn't saved.`;
}

function usePreferencesSave() {
  const queryClient = useQueryClient();
  const store = useProviderStore();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  return useMutation({
    mutationFn: (body: Parameters<typeof saveProviderPreferences>[1]): Promise<PreferencesSaveOutcome> =>
      saveProviderPreferences(queryClient, body, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (isRefusal(outcome)) store.refused(outcome);
      else if (outcome.kind === "saved") store.saved(outcome.settings);
    },
  });
}

/**
 * Effort, saved as it changes, as the notification settings are. While a
 * save is in flight, or after one failed, the choice shows what the reader
 * asked for rather than snapping back.
 */
function EffortSection({ settings }: { settings: ProviderSettings }) {
  const id = useId();
  const save = usePreferencesSave();
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
}: {
  settings: ProviderSettings;
  usage: AccountView<ProviderUsage>;
  onRetryUsage: () => void;
}) {
  const id = useId();
  const save = usePreferencesSave();
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

  // Retry sends the change that failed: a new cap, or putting the default back.
  function retrySave() {
    if (save.variables !== undefined) save.mutate(save.variables);
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
        <InlineNotice message={saveFailureMessage(failure, "Your limit")} onAction={retrySave}>
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
