import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type RefObject } from "react";
import { revokeAllSessions, revokeSession } from "../api/sessions";
import { NetworkError, isUnauthorized } from "../api/errors";
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
} from "../sessions";
import { sessionsQueryOptions } from "../sessions-query";
import { sessionsViewOf, type SessionsView } from "../sessions-state";
import { ConfirmDialog } from "./ConfirmDialog";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { BackToLibrary } from "./BackToLibrary";
import {
  AccountChanged,
  Forbidden,
  LoadingRegion,
  OfflineNotice,
  ServerError,
} from "./ReadingStates";

// Session management on the account page (#340.1, Phase 5 of #340). The list,
// a single revoke, and revoke-all match the SPA (`web/src/App.tsx`); the
// common states are the acceptance matrix's, shared with the library and
// save. Revoking this device, or every session, drops the account without
// calling logout — the cookie is already cleared — and the signed-in guard
// sends the reader to sign in.

type RevokeTarget = { kind: "one"; session: SessionListItem } | { kind: "all" };

type AccountView =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "server-error"; message: string; retry: "list" | "revoke" }
  | { kind: "offline"; listed?: SessionsList }
  | { kind: "ready"; listed: SessionsList };

export function AccountPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const { data, error, fetchStatus, refetch } = useQuery(sessionsQueryOptions(queryClient, identity));
  const [refused, setRefused] = useState<Exclude<RevokeOutcome, { kind: "revoked" }> | null>(null);
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
      if (outcome.kind !== "revoked") {
        setRefused(outcome);
        return;
      }
      // This device, or every session: the backend already expired the cookie.
      if (target.kind === "all" || target.session.current) {
        dropSignedInAccount(queryClient);
        await router.invalidate();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(identity?.user_id ?? "") });
    },
  });

  const busy = revoke.isPending;
  const listView = sessionsViewOf({ data, error: revoke.error ? null : error, fetchStatus });
  const view = viewOf(listView, refused, revoke.error);

  function send(target: RevokeTarget) {
    if (busy) return;
    revoke.reset();
    setRefused(null);
    revoke.mutate(target);
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
        onRetryList: () => {
          revoke.reset();
          setRefused(null);
          void refetch();
        },
        onRetryRevoke: () => {
          revoke.reset();
          setRefused(null);
        },
        revokeAllRef,
      })}
    </PageStateFocus>
  );
}

function viewOf(
  list: SessionsView,
  refused: Exclude<RevokeOutcome, { kind: "revoked" }> | null,
  error: unknown,
): AccountView {
  if (refused?.kind === "forbidden" || refused?.kind === "account-changed") return refused;
  if (error instanceof NetworkError && error.offline) {
    const listed = list.kind === "ready" || list.kind === "offline" ? list.listed : undefined;
    return { kind: "offline", ...(listed ? { listed } : {}) };
  }
  if (error && !isUnauthorized(error)) {
    return { kind: "server-error", message: error instanceof Error ? error.message : String(error), retry: "revoke" };
  }
  if (list.kind === "server-error") return { ...list, retry: "list" };
  return list;
}

function pageFor(
  view: AccountView,
  actions: {
    busy: boolean;
    confirmAll: boolean;
    onConfirmAll: () => void;
    onCloseConfirm: () => void;
    onRevokeAll: () => void;
    onRevoke: (session: SessionListItem) => void;
    onRetryList: () => void;
    onRetryRevoke: () => void;
    revokeAllRef: RefObject<HTMLButtonElement | null>;
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
      return (
        <ServerError
          message={view.message}
          onRetry={view.retry === "list" ? actions.onRetryList : actions.onRetryRevoke}
        />
      );
    default:
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
          {view.kind === "offline" ? <OfflineNotice onRetry={actions.onRetryList} /> : null}
          {view.kind === "loading" ? <LoadingRegion /> : null}
          {view.kind === "ready" || (view.kind === "offline" && view.listed) ? (
            <SessionsSection
              listed={view.kind === "ready" ? view.listed : view.listed!}
              busy={actions.busy}
              onRevoke={actions.onRevoke}
            />
          ) : null}
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

function SessionsSection({
  listed,
  busy,
  onRevoke,
}: {
  listed: SessionsList;
  busy: boolean;
  onRevoke: (session: SessionListItem) => void;
}) {
  return (
    <section className="account-section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading" className="account-section-title">
        Sessions
      </h2>
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
    </section>
  );
}
