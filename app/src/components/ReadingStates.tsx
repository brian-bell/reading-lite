import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { previousHop, type TrailHop } from "../reading-trail";
import { PageHeading } from "./PageHeading";
import { BackTo } from "./ReturnTrail";
import { BackToLibrary } from "./BackToLibrary";

// The states a page shows instead of its content (acceptance matrix, Common
// states and Reading detail). Each is a real page with its own heading, so
// focus after navigation lands on what happened, and the URL stays put. The
// reading page and the library (#416) share them; ReadingForbidden and
// ReadingLoading add the reading page's own action and heading.
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
        <BackToLibrary className="button" />
      </div>
    </StatePage>
  );
}

/**
 * 404 for an inbox item (reading-lite-fy8t): added to the library or
 * discarded from another tab, or by the agent that staged it, or a wrong link.
 */
export function InboxItemNotFound() {
  return (
    <StatePage heading="This item isn't in your inbox.">
      <p className="auth-lede">It may have been added to your library or discarded.</p>
      <div className="form-actions">
        <Link to="/inbox" className="button button-primary">
          Back to inbox
        </Link>
      </div>
    </StatePage>
  );
}

/**
 * 403. Never a sign-out: the session stays exactly as it was. `children` is
 * the action offered, if the page has one to offer.
 */
export function Forbidden({ children }: { children?: ReactNode }) {
  return <StatePage heading="You don't have access to this.">{children}</StatePage>;
}

export function ReadingForbidden() {
  return (
    <Forbidden>
      <div className="form-actions">
        <BackToLibrary className="button" />
      </div>
    </Forbidden>
  );
}

/**
 * 412. The session cookie is shared between tabs, so another tab signing in as
 * someone else re-points this one mid-read. The pin catches it; a reload picks
 * up whoever is signed in now.
 */
export function AccountChanged({ actingTenant }: { actingTenant?: string }) {
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

/** 5xx, an unparseable body, or the binding being down: retryable. */
export function ServerError({ message, onRetry }: { message: string; onRetry: () => void }) {
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
 * A refusal that leaves the page standing (acceptance matrix, Common states):
 * a sentence, optionally something to go to instead, and optionally the one
 * control that gets past it. An inline notice rather than a page, so whatever
 * was loaded — a library, a half-typed URL — stays on screen beneath it.
 *
 * `live` is the polite region that announces it, and it is on by default
 * because most notices appear with nothing else to say them. A page that
 * already keeps a live region of its own passes `live={false}` and puts the
 * sentence there instead: a region inserted with its text already in it is
 * generally not announced at all, so the standing region is the one that
 * works.
 *
 * `onAction` is optional because some refusals have no way on to offer — a
 * save held paused offline (#431) is sent when the browser is back, and a
 * second one would claim the URL twice — and a control that does nothing is
 * worse than none.
 */
export function InlineNotice({
  message,
  actionLabel = "Retry",
  onAction,
  children,
  live = true,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
  live?: boolean;
}) {
  return (
    <div className="offline-notice" role={live ? "status" : undefined}>
      <p className="offline-notice-text">{message}</p>
      {children}
      {onAction ? (
        <button type="button" className="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Offline: a fetch could not run for want of a network. Retry asks again by
 * hand; the query also continues on its own when the browser comes back
 * online. Every read passes both defaults.
 */
export function OfflineNotice({
  message = "You're offline. Check your connection and try again.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return <InlineNotice message={message} onAction={onRetry} />;
}

/**
 * Loading (acceptance matrix, Common states): the frame and heading render at
 * once, the content region is busy, and the word arrives only if the wait is
 * long enough to notice. No spinner-only state.
 */
export function LoadingRegion({ className = "reading-loading" }: { className?: string }) {
  return (
    <div className={className} aria-busy="true">
      <DelayedText delayMs={300}>Loading…</DelayedText>
    </div>
  );
}

export function ReadingLoading() {
  return (
    <div className="page">
      <PageHeading>Reading</PageHeading>
      <LoadingRegion />
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
