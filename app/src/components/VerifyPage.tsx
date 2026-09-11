import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { redeemLoginLink } from "../api/auth";
import { fetchIdentity } from "../api/client";
import { ApiError } from "../api/errors";
import { captureMagicLinkCredential, clearMagicLinkCredential } from "../auth/magic-link-credential";
import { consumeReturnPath } from "../auth/return-path";
import { completeSignIn } from "../auth/session";
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
  const emailChange = purpose === EMAIL_CHANGE_PURPOSE;

  useEffect(() => {
    const { pathname, search, hash, state } = router.history.location;
    setCredential(captureMagicLinkCredential(hash));
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
      if (emailChange && !(await fetchIdentity())) {
        setError(EMAIL_CHANGE_HINT);
        return;
      }
      redemptionId.current ??= `clm_${crypto.randomUUID()}`;
      await redeemLoginLink(queryClient, credential, redemptionId.current);
      clearMagicLinkCredential();
      if (!(await completeSignIn(queryClient))) throw new Error("failed to complete sign-in");
      await navigate({ href: consumeReturnPath(next), replace: true });
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
