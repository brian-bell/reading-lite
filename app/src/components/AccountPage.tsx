import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { DELETE_CONFIRM_PHRASE, type AccountDeleteOutcome } from "../account-delete";
import { accountViewOf, readRefusedBy, type AccountRefusal, type AccountView } from "../account-state";
import { deleteAccount } from "../api/account";
import { requestEmailChange } from "../api/email-change";
import { saveSettings } from "../api/settings";
import { revokeAllSessions, revokeSession } from "../api/sessions";
import { isUnauthorized, NetworkError } from "../api/errors";
import { closeAccount, dropSignedInAccount, hrefOnScreen } from "../auth/session";
import {
  changeDigest,
  digestBody,
  digestHourLabel,
  DIGEST_CADENCE_OPTIONS,
  DIGEST_HOURS,
  DIGEST_WEEKDAY_OPTIONS,
  listIanaTimeZones,
  scheduleOf,
  turnsDigestOn,
  type DigestDraft,
  type DigestSchedule,
} from "../digest";
import type { EmailChangeOutcome } from "../email-change";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf } from "../reading";
import {
  formatSessionTime,
  sessionHeading,
  sessionsQueryKey,
  type RevokeOutcome,
  type SessionListItem,
  type SessionsList,
  type SessionsResult,
} from "../sessions";
import { sessionsQueryOptions } from "../sessions-query";
import {
  settingsQueryKey,
  type DigestCadence,
  type SettingsBody,
  type SettingsResult,
  type UserSettings,
} from "../settings";
import { settingsQueryOptions } from "../settings-query";
import type { TokensList } from "../tokens";
import { tokensQueryOptions } from "../tokens-query";
import { TokensSection, type RevealedToken, type TokensSectionProps } from "./AccountTokens";
import { StepUpNotice } from "./StepUpNotice";
import { ConfirmDialog } from "./ConfirmDialog";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { BackToLibrary } from "./BackToLibrary";
import {
  AccountChanged,
  Forbidden,
  InlineNotice,
  LoadingRegion,
  OfflineNotice,
  ServerError,
} from "./ReadingStates";

// The account page (#340.1, #340.6, #340.7, #340.8; Phase 5 of #340). Email
// change, notification settings, session management — the list, a single
// revoke, and revoke-all — and API tokens match the SPA (`web/src/App.tsx`);
// the common states are
// the acceptance matrix's, shared with the library and save. A 403 or 412
// that refuses the account (from a read, a settings save, an email-change
// request, or a delete) is the whole page's state; a failed settings or
// email-change request stays inside its own section so the rest of the page
// keeps working, and an email change's recent-auth 403 is the fresh sign-in
// message there. Revoking this device, or every session, drops the account
// without calling logout — the cookie is already cleared — and the signed-in
// guard sends the reader to sign in.
//
// Account deletion is the last section (acceptance matrix, Account deletion):
// a typed `delete` in a modal, then DELETE /api/account. A stale sign-in is
// told to request a fresh link; 403 and 412 are the page's shared states, as
// for a revoke; offline and server errors stay in the section, and their
// Retry reopens the dialog rather than sending another delete unasked.
// Success drops the account and this tab alone shows the closing page.

type RevokeTarget = { kind: "one"; session: SessionListItem } | { kind: "all" };

/** What the deletion section says under its button, if anything. */
type DeleteNotice =
  | { kind: "step-up" }
  | { kind: "offline" }
  | { kind: "server-error"; message: string };

export function AccountPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const sessionsKey = sessionsQueryKey(identity?.user_id ?? "");
  const settingsKey = settingsQueryKey(identity?.user_id ?? "");
  const { data, error, fetchStatus, refetch } = useQuery(sessionsQueryOptions(queryClient, identity));
  const settingsQuery = useQuery(settingsQueryOptions(queryClient, identity));
  const tokensQuery = useQuery(tokensQueryOptions(queryClient, identity));
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const revokeAllRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const [digestDraft, setDigestDraft] = useState<DigestDraft | null>(null);
  // An email-change request refused for the account, not the address: the
  // page's own state, like a refused read.
  const [emailRefusal, setEmailRefusal] = useState<EmailRefusal | undefined>(undefined);
  // A new API token's value, shown once. Held here, not in the tokens section
  // or any cache: the page outlives every section and page state, so a failed
  // read can hide the value but not lose it before the reader copies it.
  const [revealedToken, setRevealedToken] = useState<RevealedToken | null>(null);

  const emailChange = useMutation({
    mutationFn: (email: string) => requestEmailChange(queryClient, email, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "account-changed") setEmailRefusal(outcome);
    },
  });

  const revoke = useMutation({
    mutationFn: async (target: RevokeTarget): Promise<{ target: RevokeTarget; outcome: RevokeOutcome }> => {
      const outcome =
        target.kind === "all"
          ? await revokeAllSessions(queryClient, expectedTenant)
          : await revokeSession(queryClient, target.session.id, expectedTenant);
      return { target, outcome };
    },
    networkMode: "always",
    retry: 0,
    onSuccess: async ({ target, outcome }) => {
      // A refused write shows the same page a refused list read would.
      if (outcome.kind !== "revoked") {
        queryClient.setQueryData<SessionsResult>(sessionsKey, readRefusedBy(outcome));
        return;
      }
      // This device, or every session: the backend already expired the cookie.
      if (target.kind === "all" || target.session.current) {
        dropSignedInAccount(queryClient);
        await router.invalidate();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });

  const save = useMutation({
    mutationFn: (body: SettingsBody) => saveSettings(queryClient, body, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      const stored: SettingsResult =
        outcome.kind === "saved" ? { state: "ready", value: outcome.settings } : readRefusedBy(outcome);
      queryClient.setQueryData<SettingsResult>(settingsKey, stored);
      // A draft exists only while the digest is off, so a save that leaves it
      // on is the draft's own (or its Retry): the draft is now the settings.
      if (outcome.kind === "saved" && outcome.settings.digest_cadence !== "off") setDigestDraft(null);
    },
  });

  const remove = useMutation({
    mutationFn: (): Promise<AccountDeleteOutcome> => deleteAccount(queryClient, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "deleted") {
        closeAccount(queryClient, hrefOnScreen(router));
        return;
      }
      if (outcome.kind === "forbidden" || outcome.kind === "account-changed") {
        queryClient.setQueryData<SessionsResult>(sessionsKey, readRefusedBy(outcome));
      }
      // step-up: the section shows the fresh-sign-in link from remove.data.
    },
  });

  // A failed revoke is shown as the list's own failure (a 401 is the shell's
  // page), and Retry reads the list again: the failure may mean it is stale.
  const revokeError = isUnauthorized(revoke.error) ? null : revoke.error;
  const sessionsView = accountViewOf({ data, error: revokeError ?? error, fetchStatus });
  // A failed save is not a failed read: the controls stay up with the
  // reader's choice on them, and the failure is a notice above them.
  const settingsView = accountViewOf({
    data: settingsQuery.data,
    error: settingsQuery.error,
    fetchStatus: settingsQuery.fetchStatus,
  });
  const tokensView = accountViewOf({
    data: tokensQuery.data,
    error: tokensQuery.error,
    fetchStatus: tokensQuery.fetchStatus,
  });
  const saveError = isUnauthorized(save.error) ? null : save.error;
  const saveFailure = saveError == null ? undefined : failureOf(saveError);
  const emailError = isUnauthorized(emailChange.error) ? null : emailChange.error;
  const view = pageViewOf(sessionsView, settingsView, tokensView, emailRefusal);
  // A state page replaces the page with any dialog open on it, and a dialog
  // removed that way fires no `close`, so its flag would stay set and the
  // dialog reopen by itself once Retry brings the page back.
  const replacedByState =
    view.kind === "forbidden" || view.kind === "account-changed" || view.kind === "server-error";
  useEffect(() => {
    if (!replacedByState) return;
    setConfirmAll(false);
    setConfirmDelete(false);
  }, [replacedByState]);
  const busy = revoke.isPending || remove.isPending;
  const revokingId =
    revoke.isPending && revoke.variables?.kind === "one" ? revoke.variables.session.id : undefined;
  const deleteNotice = deleteNoticeOf(remove.data, remove.error);

  function retry() {
    revoke.reset();
    void refetch();
  }

  function send(target: RevokeTarget) {
    if (busy) return;
    revoke.reset();
    revoke.mutate(target);
  }

  // Retry after a failed save sends the same change again; Discard puts the
  // controls back to the stored settings.
  function retrySave() {
    if (save.variables !== undefined) save.mutate(save.variables);
  }

  function saveSetting(body: SettingsBody) {
    if (save.isPending) return;
    save.reset();
    save.mutate(body);
  }

  // While a save is in flight, or after one failed, the controls show what
  // the reader asked for rather than snapping back to the stored value.
  const unsaved = save.isPending || saveFailure !== undefined ? save.variables : undefined;
  const storedSettings =
    settingsView.kind === "ready" || settingsView.kind === "offline" ? settingsView.value : undefined;
  const shown = storedSettings ? { ...storedSettings, ...unsaved } : undefined;

  function changeDigestSchedule(patch: Partial<DigestSchedule>) {
    if (!storedSettings || !shown || save.isPending) return;
    const change = changeDigest(storedSettings, shown, digestDraft, patch);
    if (change.kind === "draft") setDigestDraft(change.draft);
    else if (change.kind === "cancel") cancelDigestDraft();
    else if (change.kind === "save") saveSetting(change.body);
  }

  function saveDigestDraft() {
    if (shown && digestDraft) saveSetting(digestBody(shown, digestDraft));
  }

  // A failed save of the draft, which would otherwise keep the digest showing
  // as on. A failed save of anything else is left for its own Discard.
  const draftSaveFailed =
    saveFailure !== undefined && storedSettings !== undefined && turnsDigestOn(storedSettings, save.variables);

  // Cancel, and choosing Off, drop the draft and any failed save of it.
  function cancelDigestDraft() {
    setDigestDraft(null);
    if (draftSaveFailed) save.reset();
  }

  // Discard puts back the stored settings: after a failed draft save, that
  // closes the draft too.
  function discardSave() {
    save.reset();
    if (draftSaveFailed) setDigestDraft(null);
  }

  function openDelete() {
    if (busy) return;
    remove.reset();
    setConfirmDelete(true);
  }

  return (
    <PageStateFocus kind={view.kind}>
      {pageFor(view, {
        busy,
        confirmAll,
        onConfirmAll: () => setConfirmAll(true),
        onCloseConfirm: () => setConfirmAll(false),
        onRevokeAll: () => send({ kind: "all" }),
        onRevoke: (session) => send({ kind: "one", session }),
        onRetry: retry,
        revokeAllRef,
        revokingId,
        email: {
          current: identity?.email,
          sending: emailChange.isPending,
          outcome: emailChange.data,
          failure: emailError == null ? undefined : failureOf(emailError),
          onSend: (email) => {
            if (emailChange.isPending) return;
            emailChange.reset();
            emailChange.mutate(email);
          },
          onEdit: () => {
            if (!emailChange.isPending) emailChange.reset();
          },
          onRetry: () => {
            if (emailChange.variables !== undefined) emailChange.mutate(emailChange.variables);
          },
        },
        settings: {
          view: settingsView,
          shown,
          digestDraft,
          saving: save.isPending,
          saveFailure,
          onSave: saveSetting,
          onDigestChange: changeDigestSchedule,
          onSaveDigestDraft: saveDigestDraft,
          onCancelDigestDraft: cancelDigestDraft,
          onRetry: () => void settingsQuery.refetch(),
          onRetrySave: retrySave,
          onDiscard: discardSave,
        },
        tokens: {
          view: tokensView,
          onRetry: () => void tokensQuery.refetch(),
          revealed: revealedToken,
          onReveal: setRevealedToken,
          onDismiss: () => setRevealedToken(null),
        },
        deletion: {
          confirming: confirmDelete,
          notice: deleteNotice,
          onOpen: openDelete,
          onClose: () => setConfirmDelete(false),
          onDelete: () => {
            if (busy) return;
            remove.mutate();
          },
          buttonRef: deleteRef,
        },
      })}
    </PageStateFocus>
  );
}

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

/** How a write that threw reads: offline, or the retryable server error. */
function failureOf(error: unknown): Failure {
  const view = accountViewOf<never>({ data: undefined, error, fetchStatus: "idle" });
  return view.kind === "server-error" ? view : { kind: "offline" };
}

/** Email change refuses the account only by it having changed (a same-reader 403 is step-up). */
type EmailRefusal = Extract<AccountRefusal, { kind: "account-changed" }>;

type PageView =
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "server-error"; message: string }
  | { kind: "sections"; sessions: AccountView<SessionsList> };

/**
 * The page's own state. A refusal from any read is the whole page's, since
 * it is about the account rather than one section; a failed sessions list is
 * too, as it was before the page had other sections.
 */
function pageViewOf(
  sessions: AccountView<SessionsList>,
  settings: AccountView<UserSettings>,
  tokens: AccountView<TokensList>,
  emailChange: EmailRefusal | undefined,
): PageView {
  for (const view of [sessions, settings, tokens]) {
    if (view.kind === "forbidden") return { kind: "forbidden" };
  }
  for (const view of [sessions, settings, tokens]) {
    if (view.kind === "account-changed") return view;
  }
  if (emailChange?.kind === "account-changed") return emailChange;
  if (sessions.kind === "server-error") return sessions;
  return { kind: "sections", sessions };
}

interface EmailActions {
  /** The address mail goes to now, from whoami. */
  current: string | undefined;
  sending: boolean;
  outcome: EmailChangeOutcome | undefined;
  failure: Failure | undefined;
  onSend: (email: string) => void;
  /** The address changed: what was said about the last one no longer applies. */
  onEdit: () => void;
  /** Sends the failed request again, with the address it was for. */
  onRetry: () => void;
}

interface SettingsActions {
  view: AccountView<UserSettings>;
  /** The stored settings with any unsaved change over them. */
  shown: UserSettings | undefined;
  digestDraft: DigestDraft | null;
  saving: boolean;
  saveFailure: Failure | undefined;
  onSave: (body: SettingsBody) => void;
  onDigestChange: (patch: Partial<DigestSchedule>) => void;
  onSaveDigestDraft: () => void;
  onCancelDigestDraft: () => void;
  /** Reads the settings again after a failed read. */
  onRetry: () => void;
  onRetrySave: () => void;
  onDiscard: () => void;
}

function pageFor(
  view: PageView,
  actions: {
    busy: boolean;
    confirmAll: boolean;
    onConfirmAll: () => void;
    onCloseConfirm: () => void;
    onRevokeAll: () => void;
    onRevoke: (session: SessionListItem) => void;
    onRetry: () => void;
    revokeAllRef: RefObject<HTMLButtonElement | null>;
    /** The session whose revoke is in flight, whose button says so. */
    revokingId: string | undefined;
    email: EmailActions;
    settings: SettingsActions;
    tokens: TokensSectionProps;
    deletion: DeletionActions;
  },
) {
  switch (view.kind) {
    case "forbidden":
      return (
        <Forbidden>
          <div className="form-actions">
            <BackToLibrary className="button" />
          </div>
        </Forbidden>
      );
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={actions.onRetry} />;
    case "sections": {
      const sessions = view.sessions;
      const listed = sessions.kind === "ready" || sessions.kind === "offline" ? sessions.value : undefined;
      return (
        <div className="page account-page">
          <PageHeading>Account</PageHeading>
          <EmailSection {...actions.email} />
          <NotificationsSection {...actions.settings} />
          <section className="account-section" aria-labelledby="sessions-heading">
            {/* Revoke-all sits with the sessions it ends, not at the top of the page. */}
            <div className="account-section-head">
              <h2 id="sessions-heading" className="account-section-title">
                Sessions
              </h2>
              <button
                type="button"
                className="button"
                ref={actions.revokeAllRef}
                onClick={actions.onConfirmAll}
                disabled={actions.busy}
              >
                Revoke all sessions
              </button>
            </div>
            {sessions.kind === "offline" ? <OfflineNotice onRetry={actions.onRetry} /> : null}
            {sessions.kind === "loading" ? <LoadingRegion /> : null}
            {listed ? (
              <SessionsList
                listed={listed}
                busy={actions.busy}
                revokingId={actions.revokingId}
                onRevoke={actions.onRevoke}
              />
            ) : null}
          </section>
          <TokensSection {...actions.tokens} />
          <DeleteAccountSection busy={actions.busy} {...actions.deletion} />
          {actions.confirmAll ? (
            <ConfirmDialog
              title="Revoke all browser sessions?"
              confirmLabel="Revoke all sessions"
              onConfirm={actions.onRevokeAll}
              onClose={actions.onCloseConfirm}
              returnFocus={() => actions.revokeAllRef.current}
            >
              <p>This signs you out everywhere.</p>
            </ConfirmDialog>
          ) : null}
        </div>
      );
    }
  }
}

/**
 * Change email (#340.6.2), as the SPA's form: the new address, then a
 * generic "check your inbox" once the request is accepted. The typed address
 * stays through every outcome, so an offline or failed request can be sent
 * again as it was.
 */
function EmailSection({ current, sending, outcome, failure, onSend, onEdit, onRetry }: EmailActions) {
  const id = useId();
  const [email, setEmail] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const invalid = outcome?.kind === "invalid";
  // Acceptance matrix, Invalid input: the reason under the field, and focus on it.
  useEffect(() => {
    if (invalid) inputRef.current?.focus();
  }, [invalid, outcome]);
  return (
    <section className="account-section" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="account-section-title">
        Email
      </h2>
      {current ? (
        <p className="account-current-email">
          Mail goes to <strong>{current}</strong>.
        </p>
      ) : null}
      {failure ? (
        <InlineNotice
          message={
            failure.kind === "offline"
              ? "You're offline. The confirmation link wasn't sent."
              : "Something went wrong on our side. The confirmation link wasn't sent."
          }
          onAction={onRetry}
        >
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
        </InlineNotice>
      ) : null}
      {outcome?.kind === "step-up" ? <StepUpNotice lead="Recent sign-in required." /> : null}
      <form
        className="email-change-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSend(email);
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor={`${id}-email`}>
            New email
          </label>
          <input
            id={`${id}-email`}
            ref={inputRef}
            className="text-input"
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
              onEdit();
            }}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? `${id}-email-error` : undefined}
          />
          {invalid ? (
            <p id={`${id}-email-error`} className="field-error">
              Enter a valid email address.
            </p>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={sending}>
            Send confirmation
          </button>
        </div>
      </form>
      {/* Always in the page, so the confirmation is announced when it arrives. */}
      <p className="form-status" role="status">
        {outcome?.kind === "sent"
          ? "If that address can be used, we sent a short-lived confirmation link. Open it in this browser to finish."
          : null}
      </p>
    </section>
  );
}

/**
 * Immediate email (#340.6.1) and the digest schedule (#340.6.3), as the SPA's
 * notify-immediate and digest-schedule sections. The section carries its
 * read's loading, offline, and server-error states, and a failed save's,
 * itself; a refusal never reaches here (pageViewOf).
 */
function NotificationsSection({
  view,
  shown,
  digestDraft,
  saving,
  saveFailure,
  onSave,
  onDigestChange,
  onSaveDigestDraft,
  onCancelDigestDraft,
  onRetry,
  onRetrySave,
  onDiscard,
}: SettingsActions) {
  return (
    <section className="account-section" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="account-section-title">
        Notifications
      </h2>
      {view.kind === "loading" ? <LoadingRegion /> : null}
      {saveFailure ? (
        <InlineNotice
          message={
            saveFailure.kind === "offline"
              ? "You're offline. Your change wasn't saved."
              : "Something went wrong on our side. Your change wasn't saved."
          }
          onAction={onRetrySave}
        >
          {saveFailure.kind === "server-error" ? <p className="form-hint">{saveFailure.message}</p> : null}
          <button type="button" className="button" onClick={onDiscard}>
            Discard
          </button>
        </InlineNotice>
      ) : view.kind === "offline" ? (
        <OfflineNotice onRetry={onRetry} />
      ) : null}
      {view.kind === "server-error" ? (
        <InlineNotice message="Something went wrong on our side." onAction={onRetry}>
          <p className="form-hint">{view.message}</p>
        </InlineNotice>
      ) : null}
      {shown ? (
        <>
          <div className="settings-group">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={shown.notify_immediate}
                onChange={(event) => onSave({ notify_immediate: event.currentTarget.checked })}
                disabled={saving}
              />
              Email me when a reading is ready
            </label>
            <p className="session-meta">
              Immediate mail on a successful reading. Uncheck to opt out. Mail goes to your current verified
              address.
            </p>
          </div>
          <DigestScheduleFields
            schedule={digestDraft ?? scheduleOf(shown)}
            drafting={digestDraft !== null}
            saving={saving}
            onChange={onDigestChange}
            onSaveDraft={onSaveDigestDraft}
            onCancelDraft={onCancelDigestDraft}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * Cadence, then — while the digest is on or being drafted — time zone, local
 * hour, and (weekly only) weekday. A draft shows Save digest and Cancel.
 */
function DigestScheduleFields({
  schedule,
  drafting,
  saving,
  onChange,
  onSaveDraft,
  onCancelDraft,
}: {
  schedule: DigestSchedule;
  drafting: boolean;
  saving: boolean;
  onChange: (patch: Partial<DigestSchedule>) => void;
  onSaveDraft: () => void;
  onCancelDraft: () => void;
}) {
  const id = useId();
  const zones = useMemo(() => listIanaTimeZones(schedule.time_zone), [schedule.time_zone]);
  return (
    <div className="settings-group" role="group" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="settings-group-title">
        Digest email
      </h3>
      <div className="digest-fields">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-cadence`}>
            Cadence
          </label>
          <select
            id={`${id}-cadence`}
            className="text-input"
            value={schedule.digest_cadence}
            onChange={(event) => onChange({ digest_cadence: event.currentTarget.value as DigestCadence })}
            disabled={saving}
          >
            {DIGEST_CADENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {schedule.digest_cadence !== "off" ? (
          <>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-time-zone`}>
                Time zone
              </label>
              <select
                id={`${id}-time-zone`}
                className="text-input"
                value={schedule.time_zone}
                onChange={(event) => onChange({ time_zone: event.currentTarget.value })}
                disabled={saving}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-hour`}>
                Local hour
              </label>
              <select
                id={`${id}-hour`}
                className="text-input"
                value={schedule.digest_hour_local}
                onChange={(event) => onChange({ digest_hour_local: Number(event.currentTarget.value) })}
                disabled={saving}
              >
                {DIGEST_HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {digestHourLabel(hour)}
                  </option>
                ))}
              </select>
            </div>
            {schedule.digest_cadence === "weekly" ? (
              <div className="field">
                <label className="field-label" htmlFor={`${id}-weekday`}>
                  Weekday
                </label>
                <select
                  id={`${id}-weekday`}
                  className="text-input"
                  value={schedule.digest_weekday}
                  onChange={(event) => onChange({ digest_weekday: Number(event.currentTarget.value) })}
                  disabled={saving}
                >
                  {DIGEST_WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {/* Always in the page, so the draft's sentence is announced when it
          arrives (a region inserted with its text is generally not). */}
      <p className="session-meta" role="status">
        {drafting ? "Digest stays off until you save. Confirm time zone, hour, and weekday in this save." : null}
      </p>
      {drafting ? (
        <div className="form-actions digest-actions">
          <button type="button" className="button button-primary" onClick={onSaveDraft} disabled={saving}>
            Save digest
          </button>
          <button type="button" className="button" onClick={onCancelDraft} disabled={saving}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="session-meta">
          Daily or weekly digest of new ready readings. Off skips digest mail. Independent of immediate email.
          Hour, weekday, and time zone stay saved when off.
        </p>
      )}
    </div>
  );
}

function SessionsList({
  listed,
  busy,
  revokingId,
  onRevoke,
}: {
  listed: SessionsList;
  busy: boolean;
  revokingId: string | undefined;
  onRevoke: (session: SessionListItem) => void;
}) {
  return (
    <>
      {listed.session_cap_warning ? (
        <p className="session-cap-warning" role="status">
          {listed.session_cap_warning}
        </p>
      ) : null}
      <ul className="session-list" aria-label="Sessions">
        {listed.sessions.map((session) => (
          <li
            key={session.id}
            className={
              session.revoked_at_ms ? "session-revoked" : session.usable ? undefined : "session-expired"
            }
          >
            <div>
              <p>{sessionHeading(session)}</p>
              <p className="session-meta">
                Signed in {formatSessionTime(session.authenticated_at_ms)} · last seen{" "}
                {formatSessionTime(session.last_seen_at_ms)}
              </p>
            </div>
            {session.usable ? (
              <button type="button" className="button" onClick={() => onRevoke(session)} disabled={busy}>
                {session.id === revokingId ? "Revoking…" : session.current ? "Revoke this device" : "Revoke"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

interface DeletionActions {
  confirming: boolean;
  notice: DeleteNotice | null;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/** A 401 is the shell's page, so it is not repeated here. */
function deleteNoticeOf(data: AccountDeleteOutcome | undefined, error: unknown): DeleteNotice | null {
  if (data?.kind === "step-up") return { kind: "step-up" };
  if (error === null || error === undefined || isUnauthorized(error)) return null;
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return { kind: "server-error", message };
}

function DeleteAccountSection({
  busy,
  confirming,
  notice,
  onOpen,
  onClose,
  onDelete,
  buttonRef,
}: DeletionActions & { busy: boolean }) {
  return (
    <section className="account-section account-delete" aria-labelledby="delete-account-heading">
      <h2 id="delete-account-heading" className="account-section-title">
        Delete account
      </h2>
      <p className="account-delete-text">
        Deleting your account signs you out and revokes every browser session and API token right away. Your
        library and everything in it is permanently deleted after seven days, and you can't sign in to this
        account in the meantime.
      </p>
      <p className="account-delete-text">This needs a sign-in from the last 10 minutes.</p>
      {notice?.kind === "step-up" ? (
        <StepUpNotice className="account-delete-step-up" />
      ) : null}
      {notice?.kind === "offline" ? <OfflineNotice onRetry={onOpen} /> : null}
      {notice?.kind === "server-error" ? (
        <InlineNotice message={`Something went wrong on our side. ${notice.message}`} onAction={onOpen} />
      ) : null}
      <div className="form-actions">
        <button type="button" className="button button-danger" ref={buttonRef} onClick={onOpen} disabled={busy}>
          Delete account…
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog
          title="Delete your account?"
          confirmLabel="Delete account"
          confirmPhrase={DELETE_CONFIRM_PHRASE}
          onConfirm={onDelete}
          onClose={onClose}
          returnFocus={() => buttonRef.current}
        >
          <p>
            Every session and API token is revoked now, and your library is permanently deleted after seven days.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
