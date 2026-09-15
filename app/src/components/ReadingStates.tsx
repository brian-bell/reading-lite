import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { previousHop, type TrailHop } from "../reading-trail";
import { PageHeading } from "./PageHeading";
import { BackTo } from "./ReturnTrail";

// The states a reading page shows instead of a reading (acceptance matrix,
// Common states and Reading detail). Each is a real page with its own heading,
// so focus after navigation lands on what happened, and the URL stays put.
//
// 401 is not here: a session that ended is the shell's page, at whatever URL
// the request failed (AppFrame + SessionEnded).

function StatePage({ heading, children }: { heading: string; children?: ReactNode }) {
  return (
    <div className="page reading-state">
      <PageHeading>{heading}</PageHeading>
      {children}
    </div>
  );
}

function BackToLibrary() {
  return (
    <div className="form-actions">
      <Link className="button" to="/">
        Back to library
      </Link>
    </div>
  );
}

/**
 * 404. Reached by following a relationship whose target is gone (acceptance
 * matrix, Arrived from a removed target), the page keeps the reason the
 * reader followed and offers the way back before the library.
 */
export function ReadingNotFound({ trail = [] }: { trail?: readonly TrailHop[] }) {
  const previous = previousHop(trail);
  return (
    <StatePage heading="This reading isn't in your library.">
      <p className="auth-lede">It may have been removed, or the link may be wrong.</p>
      {previous ? (
        <p className="reading-trail-context">
          You followed a {previous.kind} from <strong>{previous.title}</strong>: {previous.reason}
        </p>
      ) : null}
      <div className="form-actions">
        {previous ? <BackTo hops={trail} previous={previous} className="button button-primary" /> : null}
        <Link className="button" to="/">
          Back to library
        </Link>
      </div>
    </StatePage>
  );
}

/** 403. Never a sign-out: the session stays exactly as it was. */
export function ReadingForbidden() {
  return (
    <StatePage heading="You don't have access to this.">
      <BackToLibrary />
    </StatePage>
  );
}

/**
 * 412. The session cookie is shared between tabs, so another tab signing in as
 * someone else re-points this one mid-read. The pin catches it; a reload picks
 * up whoever is signed in now.
 */
export function ReadingAccountChanged({ actingTenant }: { actingTenant?: string }) {
  return (
    <StatePage heading="This tab is signed in to a different account than the page expects.">
      <p className="auth-lede">Reload to continue as the account signed in now.</p>
      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
      {actingTenant ? <p className="form-hint">Signed in as {actingTenant}.</p> : null}
    </StatePage>
  );
}

export function ReadingServerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <StatePage heading="Something went wrong on our side.">
      <p className="auth-lede">{message}</p>
      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </StatePage>
  );
}

/**
 * Loading (acceptance matrix, Common states): the frame and heading render at
 * once, the content region is busy, and the word arrives only if the wait is
 * long enough to notice. No spinner-only state.
 */
export function ReadingLoading() {
  return (
    <div className="page">
      <PageHeading>Reading</PageHeading>
      <div className="reading-loading" aria-busy="true">
        <DelayedText delayMs={300}>Loading…</DelayedText>
      </div>
    </div>
  );
}

export function DelayedText({ delayMs, children }: { delayMs: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return shown ? <p className="form-hint">{children}</p> : null;
}
