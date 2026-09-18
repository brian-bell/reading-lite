import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useId, useRef, useState, type RefObject } from "react";
import { accountViewOf, readRefusedBy, type AccountView } from "../account-state";
import { saveSettings } from "../api/settings";
import { revokeAllSessions, revokeSession } from "../api/sessions";
import { isUnauthorized } from "../api/errors";
import { dropSignedInAccount } from "../auth/session";
import {
  changeDigest,
  digestBody,
  digestHourLabel,
  DIGEST_CADENCE_OPTIONS,
  DIGEST_HOURS,
  DIGEST_WEEKDAY_OPTIONS,
  listIanaTimeZones,
  scheduleOf,
  type DigestDraft,
  type DigestSchedule,
} from "../digest";
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

// The account page (#340.1, #340.6; Phase 5 of #340). Session management —
// the list, a single revoke, and revoke-all — and notification settings match
// the SPA (`web/src/App.tsx`); the common states are the acceptance matrix's,
// shared with the library and save. A 403 or 412 from any of the page's reads
// or writes is the whole page's state; a failed settings read or save stays
// inside its own section so the sessions list keeps working. Revoking this
// device, or every session, drops the account without calling logout — the
// cookie is already cleared — and the signed-in guard sends the reader to
// sign in.

type RevokeTarget = { kind: "one"; session: SessionListItem } | { kind: "all" };

export function AccountPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const sessionsKey = sessionsQueryKey(identity?.user_id ?? "");
  const settingsKey = settingsQueryKey(identity?.user_id ?? "");
  const { data, error, fetchStatus, refetch } = useQuery(sessionsQueryOptions(queryClient, identity));
  const settingsQuery = useQuery(settingsQueryOptions(queryClient, identity));
  const [confirmAll, setConfirmAll] = useState(false);
  const revokeAllRef = useRef<HTMLButtonElement>(null);
  const [digestDraft, setDigestDraft] = useState<DigestDraft | null>(null);

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
  const saveError = isUnauthorized(save.error) ? null : save.error;
  const saveFailure = saveError == null ? undefined : failureOf(saveError);
  const view = pageViewOf(sessionsView, settingsView);
  const busy = revoke.isPending;

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
    if (!shown || save.isPending) return;
    const change = changeDigest(shown, digestDraft, patch);
    if (change.kind === "draft") setDigestDraft(change.draft);
    else saveSetting(change.body);
  }

  function saveDigestDraft() {
    if (shown && digestDraft) saveSetting(digestBody(shown, digestDraft));
  }

  // Cancel drops the draft and any failed save of it, which would otherwise
  // keep showing the digest as on.
  function cancelDigestDraft() {
    setDigestDraft(null);
    if (saveFailure) save.reset();
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
          onDiscard: () => save.reset(),
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
function pageViewOf(sessions: AccountView<SessionsList>, settings: AccountView<UserSettings>): PageView {
  for (const view of [sessions, settings]) {
    if (view.kind === "forbidden") return { kind: "forbidden" };
  }
  for (const view of [sessions, settings]) {
    if (view.kind === "account-changed") return view;
  }
  if (sessions.kind === "server-error") return sessions;
  return { kind: "sections", sessions };
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
    settings: SettingsActions;
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
          <div className="account-head">
            <PageHeading>Account</PageHeading>
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
          <NotificationsSection {...actions.settings} />
          <section className="account-section" aria-labelledby="sessions-heading">
            <h2 id="sessions-heading" className="account-section-title">
              Sessions
            </h2>
            {sessions.kind === "offline" ? <OfflineNotice onRetry={actions.onRetry} /> : null}
            {sessions.kind === "loading" ? <LoadingRegion /> : null}
            {listed ? <SessionsList listed={listed} busy={actions.busy} onRevoke={actions.onRevoke} /> : null}
          </section>
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
                {listIanaTimeZones(schedule.time_zone).map((zone) => (
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
      {drafting ? (
        <>
          <p className="session-meta" role="status">
            Digest stays off until you save. Confirm time zone, hour, and weekday in this save.
          </p>
          <div className="form-actions digest-actions">
            <button type="button" className="button button-primary" onClick={onSaveDraft} disabled={saving}>
              Save digest
            </button>
            <button type="button" className="button" onClick={onCancelDraft} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
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
  onRevoke,
}: {
  listed: SessionsList;
  busy: boolean;
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
                {session.current ? "Revoke this device" : "Revoke"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
