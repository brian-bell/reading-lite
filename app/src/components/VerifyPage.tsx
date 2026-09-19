import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { redeemLoginLink } from "../api/auth";
import { fetchIdentity } from "../api/client";
import { ApiError } from "../api/errors";
import { ACCOUNT_SECURITY_PATH, consumeReturnPath } from "../auth/return-path";
import { completeSignIn } from "../auth/session";
import { whoamiQueryKey } from "../identity";
import { PageHeading } from "./PageHeading";

// Magic-link redemption on /auth/verify (the emailed link) and /login/verify
// (acceptance matrix). The credential is in the fragment, which never reaches
// the server, so the server renders the page with Continue held; the browser
// captures the fragment, removes it from the address bar, and redeems only on
// Continue. Afterwards the reader goes to `next`, or the path remembered by the
// tab that requested the link, or the library.

const EMAIL_CHANGE_PURPOSE = "email_change";
const EMAIL_CHANGE_HINT = "Open this link in the signed-in browser that requested the email change.";

export interface VerifySearch {
  next?: string;
  purpose?: string;
}

export function validateVerifySearch(search: Record<string, unknown>): VerifySearch {
  return {
    next: typeof search.next === "string" ? search.next : undefined,
    purpose: typeof search.purpose === "string" ? search.purpose : undefined,
  };
}

export function VerifyPage({ next, purpose }: { next?: string; purpose?: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  // null until the browser has read the fragment.
  const [credential, setCredential] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redemptionId = useRef<string | null>(null);
  // The credential lives here and not in module state: this module is loaded
  // during server renders too, where a module-level value is shared by every
  // request, and single-use sign-in material must never outlive one (#384
  // review). A ref survives the cleanup and re-run of a StrictMode remount,
  // which is the reason the captured value outlives the URL at all.
  const held = useRef("");
  const emailChange = purpose === EMAIL_CHANGE_PURPOSE;

  useEffect(() => {
    const { pathname, search, hash, state } = router.history.location;
    const fromUrl = hash.replace(/^#/, "").trim();
    if (fromUrl !== "") held.current = fromUrl;
    setCredential(held.current);
    if (hash === "") return;
    // Through the router's history, so its location (and every link built from
    // it) drops the secret too.
    router.history.replace(`${pathname}${search}`, state);
  }, [router]);

  async function onContinue() {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      if (emailChange) {
        // An email change is the one redemption the backend gates on CSRF, and
        // apiFetch takes that token from the cached identity. Cache what this
        // read returns rather than reading past the cache, or a cold or errored
        // whoami sends no token and the backend answers 403 (#384 review).
        const identity = await fetchIdentity();
        queryClient.setQueryData(whoamiQueryKey, identity);
        if (!identity) {
          setError(EMAIL_CHANGE_HINT);
          return;
        }
      }
      redemptionId.current ??= `clm_${crypto.randomUUID()}`;
      await redeemLoginLink(queryClient, credential, redemptionId.current);
      held.current = "";
      if (!(await completeSignIn(queryClient))) throw new Error("failed to complete sign-in");
      // The emailed email-change link carries no `next`; it was asked for on
      // the account page, so that is where confirming it returns.
      await navigate({
        href: consumeReturnPath(next ?? (emailChange ? ACCOUNT_SECURITY_PATH : undefined)),
        replace: true,
      });
    } catch (e) {
      if (emailChange && e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setError(EMAIL_CHANGE_HINT);
        return;
      }
      setError(e instanceof Error ? e.message : "failed to complete sign-in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page auth-page">
      <PageHeading>Complete sign-in</PageHeading>
      {credential === "" ? (
        <p className="auth-lede">
          This sign-in link is missing its secret. <a href="/login">Request a new link.</a>
        </p>
      ) : (
        <>
          <p className="auth-lede">Confirm to finish signing in. This does nothing until you continue.</p>
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={credential === null || busy}
              onClick={() => void onContinue()}
            >
              Continue
            </button>
          </div>
        </>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
