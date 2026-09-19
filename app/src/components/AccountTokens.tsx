import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { readRefusedBy, type AccountView } from "../account-state";
import { isUnauthorized, NetworkError } from "../api/errors";
import { createToken, revokeToken } from "../api/tokens";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf } from "../reading";
import {
  TOKEN_LIMIT_WARNING,
  TOKEN_NAME_MAX,
  TOKEN_SCOPES,
  tokenHeading,
  tokensQueryKey,
  tokenStatus,
  tokenTimes,
  withRevokedTokens,
  type TokenCreateBody,
  type TokenCreateOutcome,
  type TokenListItem,
  type TokenRevokeOutcome,
  type TokenScope,
  type TokensList,
  type TokensResult,
} from "../tokens";
import { ConfirmDialog } from "./ConfirmDialog";
import { InlineNotice, LoadingRegion, OfflineNotice } from "./ReadingStates";

// API tokens on the account page (#340.7, Phase 5 of #340), as the SPA's API
// tokens section (`web/src/App.tsx`): each token's name, format, status,
// scopes, and times, Revoke on a usable one, and a form that creates a token
// and shows its value once (CreateTokenForm). The section carries its
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
  /**
   * A new token's value, held by the page rather than this section: the
   * section and the form under it come and go with the list's state and the
   * page's, and the value can't be fetched again.
   */
  revealed: RevealedToken | null;
  onReveal: (token: RevealedToken) => void;
  onDismiss: () => void;
}

export function TokensSection({ view, onRetry, revealed, onReveal, onDismiss }: TokensSectionProps) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const tokensKey = tokensQueryKey(identity?.user_id ?? "");
  const [revokedIds, setRevokedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<{ token: TokenListItem; opener: HTMLElement } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

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
      {/* Outside the list's own state: a failed list read must not take the value with it. */}
      {revealed ? (
        <TokenReveal
          revealed={revealed}
          onDismiss={() => {
            onDismiss();
            (nameRef.current ?? headingRef.current)?.focus();
          }}
        />
      ) : null}
      {shown ? <CreateTokenForm onRetry={onRetry} onCreated={onReveal} nameRef={nameRef} /> : null}
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

/** A new token's value, the one time the backend returns it. */
export interface RevealedToken {
  name: string;
  secret: string;
}

/**
 * The new token's value with Copy and Dismiss, as the SPA's token-reveal
 * panel. Focus moves to it when it appears: it is what the reader came for.
 */
function TokenReveal({ revealed, onDismiss }: { revealed: RevealedToken; onDismiss: () => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    ref.current?.focus();
    setCopied(null);
  }, [revealed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="token-reveal" ref={ref} tabIndex={-1} aria-labelledby={`${id}-reveal`}>
      <p id={`${id}-reveal`} className="token-reveal-title">
        Copy the token for “{revealed.name}” now. It won't be shown again.
      </p>
      <code className="token-secret">{revealed.secret}</code>
      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : "Copy"}
        </button>
        <button type="button" className="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <p className="session-meta" role="status">
        {copied === "failed" ? "Couldn't copy. Select the token and copy it yourself." : null}
      </p>
    </div>
  );
}

/**
 * What a create resolved to, as the mutation keeps it: never the secret. The
 * secret goes straight to the page's state (onCreated), so no cache on the
 * QueryClient holds it.
 */
type CreateResult = Exclude<TokenCreateOutcome, { kind: "created" }> | { kind: "created" };

type FieldError = "name" | "scopes";

/**
 * Name and scopes, as the SPA's create form (`onCreateToken`): every scope
 * starts selected, and a blank name or no scope is refused before any
 * request. A created token's value goes to `onCreated`.
 */
function CreateTokenForm({
  onRetry,
  onCreated,
  nameRef,
}: {
  onRetry: () => void;
  onCreated: (token: RevealedToken) => void;
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const tokensKey = tokensQueryKey(identity?.user_id ?? "");
  const id = useId();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<TokenScope>>(() => new Set(TOKEN_SCOPES));
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const scopesRef = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: async (body: TokenCreateBody): Promise<CreateResult> => {
      const outcome = await createToken(queryClient, body, expectedTenant);
      if (outcome.kind !== "created") return outcome;
      onCreated({ name: outcome.name, secret: outcome.secret });
      return { kind: "created" };
    },
    networkMode: "always",
    retry: 0,
    onSuccess: async (result) => {
      if (result.kind === "forbidden" || result.kind === "account-changed") {
        queryClient.setQueryData<TokensResult>(tokensKey, readRefusedBy(result));
        return;
      }
      if (result.kind !== "created") return;
      setName("");
      setScopes(new Set(TOKEN_SCOPES));
      await queryClient.invalidateQueries({ queryKey: tokensKey });
    },
  });

  useEffect(() => {
    if (fieldError === "name") nameRef.current?.focus();
    if (fieldError === "scopes") scopesRef.current?.focus();
  }, [fieldError]);

  const failure = create.error == null || isUnauthorized(create.error) ? undefined : failureOf(create.error);
  const outcome = create.data;

  function submit() {
    if (create.isPending) return;
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > TOKEN_NAME_MAX) {
      setFieldError("name");
      return;
    }
    const chosen = TOKEN_SCOPES.filter((scope) => scopes.has(scope));
    if (chosen.length === 0) {
      setFieldError("scopes");
      return;
    }
    setFieldError(null);
    create.reset();
    create.mutate({ name: trimmed, scopes: chosen });
  }

  function toggleScope(scope: TokenScope) {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
    if (fieldError === "scopes") setFieldError(null);
  }

  return (
    <>
      {failure ? (
        <InlineNotice
          message={
            failure.kind === "offline"
              ? "You're offline. The token wasn't created."
              : "Something went wrong on our side. The token wasn't created."
          }
          onAction={() => {
            create.reset();
            onRetry();
          }}
        >
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
        </InlineNotice>
      ) : null}
      {outcome?.kind === "step-up" ? (
        <p className="form-error" role="alert">
          Recent sign-in required. The token wasn't created.
        </p>
      ) : null}
      {outcome?.kind === "limit" ? (
        <p className="form-error" role="alert">
          {TOKEN_LIMIT_WARNING}
        </p>
      ) : null}
      {outcome?.kind === "invalid" ? (
        <p className="form-error" role="alert">
          The token wasn't created. Check the name and scopes, then try again.
        </p>
      ) : null}
      <form
        className="token-create-form"
        noValidate
        aria-labelledby={`${id}-title`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3 id={`${id}-title`} className="settings-group-title">
          Create a token
        </h3>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            className="text-input"
            type="text"
            maxLength={TOKEN_NAME_MAX}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (fieldError === "name") setFieldError(null);
            }}
            aria-invalid={fieldError === "name" ? true : undefined}
            aria-describedby={fieldError === "name" ? `${id}-name-error` : undefined}
          />
          {fieldError === "name" ? (
            <p id={`${id}-name-error`} className="field-error">
              Enter a name.
            </p>
          ) : null}
        </div>
        <fieldset
          className="token-scopes"
          aria-invalid={fieldError === "scopes" ? true : undefined}
          aria-describedby={fieldError === "scopes" ? `${id}-scopes-error` : undefined}
        >
          <legend className="field-label">Scopes</legend>
          {TOKEN_SCOPES.map((scope, index) => (
            <label key={scope} className="settings-toggle">
              <input
                type="checkbox"
                ref={index === 0 ? scopesRef : undefined}
                checked={scopes.has(scope)}
                onChange={() => toggleScope(scope)}
              />
              {scope}
            </label>
          ))}
          {fieldError === "scopes" ? (
            <p id={`${id}-scopes-error`} className="field-error">
              Select at least one scope.
            </p>
          ) : null}
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            Create token
          </button>
        </div>
      </form>
    </>
  );
}

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

function failureOf(error: unknown): Failure {
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return { kind: "server-error", message };
}
