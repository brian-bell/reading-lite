import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import { getLoginOptions, requestLoginLink } from "../api/auth";
import { rememberReturnPath } from "../auth/return-path";
import { whoamiQueryOptions } from "../identity-query";
import { LoginLegalLinks } from "./LegalPages";
import { PageHeading } from "./PageHeading";
import { TurnstileWidget } from "./TurnstileWidget";

// Magic-link request (acceptance matrix, `/login`): Turnstile when configured,
// `next` remembered for the tab that opens the link, and step-up with the
// signed-in email locked. Rendered on /login and in place on a signed-out `/`.

const loginOptionsQueryKey = ["login-options"] as const;

export function SignInPage({ next, stepUp }: { next?: string; stepUp?: boolean }) {
  const identity = useQuery(whoamiQueryOptions());
  // Identity could not be determined (a 403 or an unreadable body is never a
  // sign-out). Offering the form here would ask a signed-in reader to sign in
  // again, and would show step-up with an editable address.
  if (identity.isError) {
    return (
      <div className="page auth-page">
        <PageHeading>Sign in</PageHeading>
        <p className="auth-lede">We couldn’t check whether you’re signed in.</p>
        <div className="form-actions">
          <button type="button" className="button" onClick={() => void identity.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const lockedEmail = stepUp && identity.data ? identity.data.email : undefined;
  return (
    <div className="page auth-page">
      <PageHeading>Sign in</PageHeading>
      {lockedEmail ? (
        <p className="auth-lede">Confirm it’s you. We’ll email a fresh sign-in link to this address.</p>
      ) : (
        <p className="auth-lede">We’ll email you a sign-in link. No password needed.</p>
      )}
      <SignInForm next={next} lockedEmail={lockedEmail} />
      <LoginLegalLinks />
    </div>
  );
}

function SignInForm({ next, lockedEmail }: { next?: string; lockedEmail?: string }) {
  const queryClient = useQueryClient();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetEpoch, setWidgetEpoch] = useState(0);
  const [widgetError, setWidgetError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // Browser only: server renders show the form with submit held until this loads.
  const options = useQuery({
    queryKey: loginOptionsQueryKey,
    queryFn: () => getLoginOptions(queryClient),
    retry: false,
    staleTime: Infinity,
  });
  const siteKey = options.data?.turnstile_site_key ?? null;
  const optionsBlocked = options.isPending || options.isError;
  const submitBlocked = optionsBlocked || submitting || widgetError != null || (siteKey != null && !turnstileToken);
  const emailValue = lockedEmail ?? email;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || optionsBlocked || widgetError != null) return;
    if (siteKey != null && !turnstileToken) {
      setError("Complete the check before requesting a link.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    // Before the request, so a link opened quickly in a new tab still finds it.
    rememberReturnPath(next);
    try {
      await requestLoginLink(queryClient, emailValue, turnstileToken);
      setSent(true);
    } catch (e) {
      setSent(false);
      setError(e instanceof Error ? e.message : "failed to request sign-in link");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      // A Turnstile token is single-use.
      setTurnstileToken(null);
      if (siteKey != null) setWidgetEpoch((epoch) => epoch + 1);
    }
  }

  return (
    <>
      <form className="auth-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="field-label" htmlFor={emailId}>
            Email
          </label>
          <input
            id={emailId}
            className="text-input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={emailValue}
            readOnly={lockedEmail != null}
            onChange={(event) => {
              if (lockedEmail == null) setEmail(event.target.value);
            }}
          />
        </div>
        {siteKey != null ? (
          <TurnstileWidget
            key={widgetEpoch}
            siteKey={siteKey}
            onToken={(token) => {
              setTurnstileToken(token);
              if (token) setWidgetError(null);
            }}
            onError={(e) => setWidgetError(e.message)}
          />
        ) : null}
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={submitBlocked}>
            Email me a link
          </button>
          {options.isPending ? <span className="form-hint">Loading sign-in options…</span> : null}
        </div>
      </form>
      {options.isError ? (
        <RetryableError message={options.error.message} onRetry={() => void options.refetch()} />
      ) : null}
      {widgetError ? (
        <RetryableError
          message={widgetError}
          onRetry={() => {
            setWidgetError(null);
            setTurnstileToken(null);
            setWidgetEpoch((epoch) => epoch + 1);
          }}
        />
      ) : null}
      <p className="form-status" role="status">
        {sent ? "If that address can sign in, we sent a short-lived link." : null}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function RetryableError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="form-error" role="alert">
      <p>{message}</p>
      <button type="button" className="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
