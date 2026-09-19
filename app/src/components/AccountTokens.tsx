import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { readRefusedBy, type AccountView } from "../account-state";
import { isUnauthorized, NetworkError } from "../api/errors";
import { revokeToken } from "../api/tokens";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf } from "../reading";
import {
  tokenHeading,
  tokensQueryKey,
  tokenStatus,
  tokenTimes,
  withRevokedTokens,
  type TokenListItem,
  type TokenRevokeOutcome,
  type TokensList,
  type TokensResult,
} from "../tokens";
import { ConfirmDialog } from "./ConfirmDialog";
import { InlineNotice, LoadingRegion, OfflineNotice } from "./ReadingStates";

// API tokens on the account page (#340.7, Phase 5 of #340), as the SPA's API
// tokens section (`web/src/App.tsx`): each token's name, format, status,
// scopes, and times, and Revoke on a usable one. The section carries its
// read's loading, offline, and server-error states, and a failed revoke's,
// itself; a refused read never reaches here (AccountPage's pageViewOf), and a
// refused revoke is stored as the read's result so the page shows the same
// state.
//
// A revoke is confirmed first: a script using the token stops working. Once
// the backend has revoked it (or answers 404, gone from another tab), the row
// shows revoked at once and stays that way through the list read that
// follows, as the SPA's revoked-ids overlay does. Focus the browser dropped
// from the row's Revoke button, on success or failure, goes to the section
// heading.

export interface TokensSectionProps {
  view: AccountView<TokensList>;
  /** Reads the tokens again. */
  onRetry: () => void;
}

export function TokensSection({ view, onRetry }: TokensSectionProps) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const tokensKey = tokensQueryKey(identity?.user_id ?? "");
  const [revokedIds, setRevokedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<{ token: TokenListItem; opener: HTMLElement } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const revoke = useMutation({
    mutationFn: async (token: TokenListItem): Promise<TokenRevokeOutcome> =>
      revokeToken(queryClient, token.id, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: async (outcome, token) => {
      if (outcome.kind === "forbidden" || outcome.kind === "account-changed") {
        queryClient.setQueryData<TokensResult>(tokensKey, readRefusedBy(outcome));
        return;
      }
      setRevokedIds((current) => new Set(current).add(token.id));
      await queryClient.invalidateQueries({ queryKey: tokensKey });
    },
  });

  // Focus went back to the row's Revoke button when the dialog closed, and a
  // browser drops it to the body when that button is disabled for the request
  // or goes once the row shows revoked. Once the revoke settles either way,
  // keep focus in the section, just above any failure notice.
  const settled = revoke.isSuccess || revoke.isError;
  useEffect(() => {
    if (settled && document.activeElement === document.body) headingRef.current?.focus();
  }, [settled, revokedIds]);

  const listed = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
  const shown = listed ? withRevokedTokens(listed, revokedIds, Date.now()) : undefined;
  // A 401 is the shell's page, so it is not repeated here.
  const failure = revoke.error == null || isUnauthorized(revoke.error) ? undefined : failureOf(revoke.error);
  const busy = revoke.isPending;

  // Retry after a failed revoke reads the list again rather than sending the
  // revoke unasked: the failure may mean the list is stale.
  function retryAfterFailure() {
    revoke.reset();
    onRetry();
  }

  return (
    <section className="account-section" aria-labelledby="api-tokens-heading">
      <h2 id="api-tokens-heading" className="account-section-title" ref={headingRef} tabIndex={-1}>
        API tokens
      </h2>
      {view.kind === "loading" ? <LoadingRegion /> : null}
      {failure ? (
        <InlineNotice
          message={
            failure.kind === "offline"
              ? "You're offline. The token wasn't revoked."
              : "Something went wrong on our side. The token wasn't revoked."
          }
          onAction={retryAfterFailure}
        >
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
        </InlineNotice>
      ) : view.kind === "offline" ? (
        <OfflineNotice onRetry={onRetry} />
      ) : null}
      {view.kind === "server-error" ? (
        <InlineNotice message="Something went wrong on our side." onAction={onRetry}>
          <p className="form-hint">{view.message}</p>
        </InlineNotice>
      ) : null}
      {shown?.tokens.length === 0 ? <p className="session-meta">No API tokens yet.</p> : null}
      {shown && shown.tokens.length > 0 ? (
        <ul className="session-list" aria-label="API tokens">
          {shown.tokens.map((token) => {
            const status = tokenStatus(token);
            return (
              <li
                key={token.id}
                className={
                  status === "revoked" ? "session-revoked" : status === "expired" ? "session-expired" : undefined
                }
              >
                <div>
                  <p>{tokenHeading(token)}</p>
                  <p className="session-meta">{token.scopes.join(", ")}</p>
                  <p className="session-meta">{tokenTimes(token)}</p>
                </div>
                {token.usable ? (
                  <button
                    type="button"
                    className="button"
                    aria-label={`Revoke ${token.name}`}
                    onClick={(event) => {
                      if (busy) return;
                      setConfirming({ token, opener: event.currentTarget });
                    }}
                    disabled={busy}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title="Revoke this API token?"
          confirmLabel="Revoke token"
          onConfirm={() => {
            revoke.reset();
            revoke.mutate(confirming.token);
          }}
          onClose={() => setConfirming(null)}
          returnFocus={() => confirming.opener}
        >
          <p>Anything using “{confirming.token.name}” stops working right away. This can't be undone.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

function failureOf(error: unknown): Failure {
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return { kind: "server-error", message };
}
