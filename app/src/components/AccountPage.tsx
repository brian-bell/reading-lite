import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type RefObject } from "react";
import { accountViewOf, readRefusedBy, type AccountView } from "../account-state";
import { saveSettings } from "../api/settings";
import { revokeAllSessions, revokeSession } from "../api/sessions";
import { isUnauthorized } from "../api/errors";
import { dropSignedInAccount } from "../auth/session";
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
import { settingsQueryKey, type SettingsBody, type SettingsResult, type UserSettings } from "../settings";
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
    },
  });

  // A failed revoke is shown as the list's own failure (a 401 is the shell's
  // page), and Retry reads the list again: the failure may mean it is stale.
  const revokeError = isUnauthorized(revoke.error) ? null : revoke.error;
  const sessionsView = accountViewOf({ data, error: revokeError ?? error, fetchStatus });
  // A failed save is shown as the settings' own failure, the same way.
  const saveError = isUnauthorized(save.error) ? null : save.error;
  const settingsView = accountViewOf({
    data: settingsQuery.data,
    error: saveError ?? settingsQuery.error,
    fetchStatus: settingsQuery.fetchStatus,
  });
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

  // Retry after a failed save sends it again, so the change the reader made
  // is not lost to a dropped connection; after a failed read, it reads again.
  function retrySettings() {
    if (saveError != null && save.variables !== undefined) {
      save.mutate(save.variables);
      return;
    }
    save.reset();
    void settingsQuery.refetch();
  }

  function saveSetting(body: SettingsBody) {
    if (save.isPending) return;
    save.reset();
    save.mutate(body);
  }

  // While a save is in flight, or after one failed, the controls show what
  // the reader asked for rather than snapping back to the stored value.
  const unsaved = save.isPending || saveError != null ? save.variables : undefined;

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
          unsaved,
          saving: save.isPending,
          onSave: saveSetting,
          onRetry: retrySettings,
        },
      })}
    </PageStateFocus>
  );
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
  unsaved: SettingsBody | undefined;
  saving: boolean;
  onSave: (body: SettingsBody) => void;
  onRetry: () => void;
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
 * Immediate email (#340.6.1), as the SPA's notify-immediate section. The
 * section carries its read's loading, offline, and server-error states itself;
 * a refusal never reaches here (pageViewOf).
 */
function NotificationsSection({ view, unsaved, saving, onSave, onRetry }: SettingsActions) {
  const stored = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
  const shown = stored ? { ...stored, ...unsaved } : undefined;
  return (
    <section className="account-section" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="account-section-title">
        Notifications
      </h2>
      {view.kind === "loading" ? <LoadingRegion /> : null}
      {view.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {view.kind === "server-error" ? (
        <InlineNotice message="Something went wrong on our side." onAction={onRetry}>
          <p className="form-hint">{view.message}</p>
        </InlineNotice>
      ) : null}
      {stored && shown ? (
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
            Immediate mail on a successful reading. Uncheck to opt out. Mail goes to your current verified address.
          </p>
        </div>
      ) : null}
    </section>
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
