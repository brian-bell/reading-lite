import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState, type FormEvent } from "react";
import { NetworkError } from "../api/errors";
import { submitReading } from "../api/save";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import { dateTimeOn } from "../reading-presentation";
import { saveUrlProblem, type SubmitOutcome } from "../save";
import { saveNoticeState } from "../save-notice";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { AccountChanged, Forbidden, InlineNotice, OfflineNotice, ServerError } from "./ReadingStates";
import { ViewTabs, type TabItem } from "./ViewTabs";

// Saving a URL (#431, the accepted path of Phase 4). The page is under the
// signed-in guard, so a link to it from anywhere signs the reader in and
// returns them here.
//
// The tabs are the design spec's capture surface: one tab now, and Markdown
// beside it later. The selection is local state rather than the URL — unlike
// the reading page's views, there is nothing here worth a deep link, and a
// half-typed URL should survive the switch.
//
// A save that is accepted opens the reading it created, because that page
// already says what is happening to it (the status card). What the backend
// rejects renders in the field, in the backend's own words, exactly where the
// client-side rule's own message goes: the reader sees one kind of answer,
// whichever side decided it. Everything else is the shared common state, and
// the page that replaces the form takes the focus it held, as the library's
// states do.

type SaveTab = "url";

const SAVE_TABS: readonly TabItem<SaveTab>[] = [{ key: "url", label: "URL" }];

/**
 * What is said above the form without replacing it (#433). A save the backend
 * refused for a reason that will pass — a limit, a guard that could not
 * answer, a queue that is not there — leaves the form exactly as the reader
 * left it, because the URL they typed is still the URL they want.
 *
 * Offline has the same two shapes here as on the library (#416), and they are
 * not the same state. A save started without a network never runs: React Query
 * holds the mutation paused and continues it when the browser is back, so
 * there is nothing to retry and the reader must not be offered a control that
 * does nothing. A save that failed after the network went away is over, and
 * asking again is the only way on.
 */
type SaveNotice =
  | { kind: "none" }
  | { kind: "offline-paused" }
  | { kind: "offline-failed" }
  | Exclude<Refusal, { kind: "forbidden" | "account-changed" }>;

/** What the page renders. Its name is also what the focus mechanism keys on. */
type SaveView =
  | { kind: "form"; notice: SaveNotice }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "server-error"; message: string };

/**
 * A refusal that is a value rather than a throw (save.ts): everything the
 * backend answered that is neither a reading to open nor the field's own
 * error, derived so an outcome added there has to be handled here. 403 and
 * 412 replace the form with the shared state; the rest are notices over a
 * form that stays, and are shaped as `SaveNotice` already.
 */
type Refusal = Exclude<SubmitOutcome, { kind: "accepted" | "existing" | "invalid" }>;

export function SavePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const [tab, setTab] = useState<SaveTab>("url");
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const urlId = useId();
  const problemId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // A second submit while the first is in flight, or held paused offline,
  // would claim the URL twice. Cleared only once the save has settled.
  const submittingRef = useRef(false);

  const save = useMutation({
    mutationFn: (value: string) => submitReading(queryClient, value, expectedTenant),
  });

  function reject(message: string) {
    setProblem(message);
    inputRef.current?.focus();
  }

  /**
   * The one way a save is made: the field's rule first, then the request. The
   * form's submit and the offline notice's Retry both come through here, so a
   * retry cannot get past a rule a submit would have caught.
   *
   * The outcome is handled in `mutate`'s own callbacks rather than the
   * mutation's, because query-core keeps a paused mutation in the cache after
   * this page is gone and would otherwise resume it, navigate, and pull the
   * reader off whatever they are reading. Per-call callbacks are skipped once
   * the observer has unsubscribed, so a save that resumes without this page
   * still reaches the backend and simply lands in the library.
   */
  function trySubmit(raw: string) {
    if (submittingRef.current) return;
    // The notice that asked for this is about to go, and with it the button
    // the reader pressed; focus goes back to the field, where the form's own
    // rejection also puts it, rather than falling to the document.
    if (document.activeElement?.closest(".offline-notice")) inputRef.current?.focus();
    // What the last save answered is stale the moment another is asked for,
    // including when this one never leaves: a field error beside a notice
    // still offering to retry the URL it just refused says two things at once.
    save.reset();
    setProblem(null);
    setRefused(null);
    setAnnouncement(null);
    const value = raw.trim();
    const rejected = saveUrlProblem(value);
    if (rejected !== undefined) {
      // Nothing is asked for: the reader is returned to the field with the
      // reason, and the URL stays exactly as they typed it.
      reject(rejected);
      return;
    }
    submittingRef.current = true;
    save.mutate(value, {
      onSuccess: async (outcome) => {
        if (outcome.kind === "invalid") {
          // The backend's rejection is the field's error, and the reader is
          // put back in the field to fix it, as the client-side rule does.
          reject(outcome.message);
          return;
        }
        if (outcome.kind !== "accepted" && outcome.kind !== "existing") {
          // Everything else the backend decided: a state that replaces the
          // form, or a notice over the one that stays. A notice says its
          // sentence through the region that was already on the page, because
          // one inserted with its text in it is not announced.
          if (outcome.kind === "unavailable" && outcome.id !== undefined) {
            // The reading a 503 names is a failed owner the backend just
            // rewrote in place (its rollback manifest and list row), so what
            // this tab read of it earlier is what "Open the reading" would
            // show, and what the library would keep showing. Dropped and
            // invalidated as the accepted path does, before the link exists.
            queryClient.removeQueries({ queryKey: readingQueryKey(outcome.id) });
            await queryClient.invalidateQueries({ queryKey: ["library"] });
          }
          setRefused(outcome);
          setAnnouncement(noticeSentence(outcome) ?? null);
          return;
        }
        // Politely, and without taking focus: the route change moves focus to
        // the reading's heading, which is where the reader is going. A URL
        // already in the library was not saved now, so it does not say so.
        setAnnouncement(outcome.kind === "accepted" ? "Saved. Opening the reading…" : "Opening the reading…");
        // The new reading belongs on every page of the library, filtered or not.
        await queryClient.invalidateQueries({ queryKey: ["library"] });
        // A failed owner is reprocessed in place under the same id, and the
        // reading query never goes stale on its own, so an answer this tab read
        // earlier would be what the reader lands on. Dropped rather than marked
        // stale: a stale failure would still show until the fresh read arrived.
        queryClient.removeQueries({ queryKey: readingQueryKey(outcome.id) });
        // A URL that was already the reader's says so on the reading it opens
        // (#432), in history state rather than the URL: the notice belongs to
        // the history entry this save wrote, not to the reading.
        const notice = outcome.kind === "existing" ? outcome.notice : undefined;
        await navigate({
          to: "/readings/$id",
          params: { id: outcome.id },
          state: notice ? { saveNotice: saveNoticeState(notice) } : undefined,
        });
      },
      onSettled: () => {
        submittingRef.current = false;
      },
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    trySubmit(url);
  }

  const view = viewOf(refused, save.isPaused, save.error);
  return <PageStateFocus kind={view.kind}>{pageFor(view)}</PageStateFocus>;

  function pageFor(current: SaveView) {
    switch (current.kind) {
      case "forbidden":
        return <Forbidden />;
      case "account-changed":
        return <AccountChanged actingTenant={current.actingTenant} />;
      case "server-error":
        return (
          <ServerError
            message={current.message}
            onRetry={() => {
              save.reset();
              setAnnouncement(null);
            }}
          />
        );
      default:
        return (
          <div className="page save-page">
            <PageHeading>Save reading</PageHeading>
            <SaveNoticeBanner notice={current.notice} onRetry={() => trySubmit(url)} />
            <ViewTabs label="What to save" idPrefix="save" tabs={SAVE_TABS} selected={tab} onSelect={setTab}>
              {/* The browser's own URL check would replace our message with
                  its bubble, which is neither in the page nor linked to the
                  field. */}
              <form className="save-form" onSubmit={onSubmit} noValidate>
                <div className="field">
                  <label className="field-label" htmlFor={urlId}>
                    URL
                  </label>
                  <input
                    id={urlId}
                    ref={inputRef}
                    className="text-input"
                    type="text"
                    inputMode="url"
                    name="url"
                    autoComplete="url"
                    spellCheck={false}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? problemId : undefined}
                  />
                  {problem ? (
                    <p className="field-error" id={problemId}>
                      {problem}
                    </p>
                  ) : null}
                </div>
                <div className="form-actions">
                  {/* aria-disabled, not disabled: a disabled button is blurred
                      by the browser, and the reader would lose their place
                      while the save runs — and with it the focus the state
                      page takes when one replaces this form. The submit is
                      refused by submittingRef either way. */}
                  <button
                    type="submit"
                    className="button button-primary"
                    aria-disabled={save.isPending || undefined}
                  >
                    Save
                  </button>
                </div>
              </form>
            </ViewTabs>
            {/* The page's standing polite region: on screen before there is
                anything to say, so what lands in it is announced. A refusal's
                sentence comes through here too, which is why its notice is
                not a second region. */}
            <p className="form-status" role="status">
              {announcement}
            </p>
          </div>
        );
    }
  }
}

/** A refusal outranks the request's own state: it is what the backend decided. */
function viewOf(refused: Refusal | null, paused: boolean, error: unknown): SaveView {
  if (refused) {
    if (refused.kind === "forbidden" || refused.kind === "account-changed") return refused;
    return { kind: "form", notice: refused };
  }
  if (paused) return { kind: "form", notice: { kind: "offline-paused" } };
  if (error instanceof NetworkError && error.offline) return { kind: "form", notice: { kind: "offline-failed" } };
  if (error) return { kind: "server-error", message: error instanceof Error ? error.message : String(error) };
  return { kind: "form", notice: { kind: "none" } };
}

/** Which limit was reached (acceptance matrix, Save), in the reader's terms. */
const LIMIT_REACHED: Record<string, string> = {
  request_rate: "You've reached the request rate limit.",
  hourly: "You've reached the hourly reading limit.",
  monthly: "You've reached the monthly reading limit.",
};

/** A window the backend named that this page has never heard of (save.ts). */
const LIMIT_REACHED_UNKNOWN = "You've reached a limit.";

/**
 * What a notice says, in one place: the banner renders it, and the page's
 * live region announces it, and the reader must not be given two wordings of
 * the same refusal. Offline keeps its own sentences in the shared notice.
 */
function noticeSentence(notice: SaveNotice | Refusal): string | undefined {
  switch (notice.kind) {
    case "limited": {
      const reached = LIMIT_REACHED[notice.limit] ?? LIMIT_REACHED_UNKNOWN;
      const resets = dateTimeOn(notice.resetAt);
      return resets ? `${reached} It resets at ${resets}.` : reached;
    }
    case "guard-unavailable":
      return "Limits can't be checked right now.";
    case "unavailable":
      return "Saving is unavailable right now.";
    default:
      return undefined;
  }
}

/**
 * The notice above the form, with a way on only when there is one to offer.
 *
 * "Try again" is live from the moment the notice appears rather than counting
 * down to the reset: the limit is the backend's to enforce, and a reader who
 * asks again a moment early gets the same sentence back, which is a smaller
 * cost than a control they cannot use. The 503's operator-facing error string
 * is not shown; the reading it names, when it names one, is worth opening.
 *
 * A refusal's notice is not itself a live region (`live={false}`): the page's
 * own `form-status` was already there to be announced, and this one was not.
 * Offline keeps the shared default, as the library's does.
 */
function SaveNoticeBanner({ notice, onRetry }: { notice: SaveNotice; onRetry: () => void }) {
  if (notice.kind === "none") return null;
  if (notice.kind === "offline-paused") {
    return <OfflineNotice message="You're offline. This save will be sent when your connection returns." />;
  }
  if (notice.kind === "offline-failed") return <OfflineNotice onRetry={onRetry} />;
  return (
    <InlineNotice message={noticeSentence(notice)!} actionLabel="Try again" onAction={onRetry} live={false}>
      {notice.kind === "unavailable" && notice.id ? (
        <Link className="notice-link" to="/readings/$id" params={{ id: notice.id }}>
          Open the reading
        </Link>
      ) : null}
    </InlineNotice>
  );
}
