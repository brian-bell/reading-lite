import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useHydrated, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { NetworkError } from "../api/errors";
import { importMarkdown, submitReading } from "../api/save";
import { whoamiQueryKey, type Identity } from "../identity";
import {
  firstProblemField,
  markdownImportBody,
  markdownImportProblems,
  type MarkdownImportBody,
  type MarkdownImportProblems,
  type MarkdownImportValues,
} from "../import-markdown";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import { ALREADY_PROCESSING_SENTENCE, captureRefusalSentence } from "../capture-refusal";
import { saveUrlProblem, type SubmitOutcome } from "../save";
import { saveNoticeState } from "../save-notice";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { Icon } from "./Icon";
import { MarkdownImportForm, type MarkdownImportFormHandle } from "./MarkdownImportForm";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { AccountChanged, Forbidden, InlineNotice, OfflineNotice, ServerError } from "./ReadingStates";
import { TextField } from "./TextField";
import { ViewTabs, type TabItem } from "./ViewTabs";

// Saving a URL (#431, the accepted path of Phase 4) and importing Markdown
// (#408). The page is under the signed-in guard, so a link to it from anywhere
// signs the reader in and returns them here.
//
// The tabs are the design spec's capture surface. The selection is not in the
// URL — unlike the reading page's views, there is nothing here worth a deep
// link — but it is remembered for the browser tab's session (sessionStorage),
// so a reader who imports Markdown comes back to the Markdown tab. Only the
// tab's name is stored. What is typed into either tab is this page's state
// and nothing else: it survives a tab switch and a refusal, and a pasted
// Markdown never reaches browser storage.
//
// Both tabs end in the same intake outcomes (save.ts), so they share one
// request and one way of handling what it answered; they differ only in the
// fields that ask and where a rejection lands.
//
// A save that is accepted opens the reading it created, because that page
// already says what is happening to it (the status card). What the backend
// rejects renders in the field, in the backend's own words, exactly where the
// client-side rule's own message goes: the reader sees one kind of answer,
// whichever side decided it. Everything else is the shared common state, and
// the page that replaces the form takes the focus it held, as the library's
// states do.

type SaveTab = "url" | "markdown";

const SAVE_TABS: readonly TabItem<SaveTab>[] = [
  { key: "url", label: "URL" },
  { key: "markdown", label: "Markdown" },
];

/** Where the tab is remembered for the session; see the header. */
const SAVE_TAB_KEY = "reading-lite:save-tab";

function storedTab(): SaveTab | undefined {
  try {
    const stored = window.sessionStorage.getItem(SAVE_TAB_KEY);
    return SAVE_TABS.find((tab) => tab.key === stored)?.key;
  } catch {
    // Storage the browser refuses is a tab that is not remembered.
    return undefined;
  }
}

function rememberTab(tab: SaveTab) {
  try {
    window.sessionStorage.setItem(SAVE_TAB_KEY, tab);
  } catch {
    // As above: nothing to remember it in.
  }
}

/** What a submit asks for: one request, whichever tab it came from. */
type CaptureRequest = { kind: "url"; url: string } | { kind: "markdown"; body: MarkdownImportBody };

const NO_MARKDOWN: MarkdownImportValues = { sourceUrl: "", title: "", markdown: "" };

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
  // The server renders the URL tab, and while hydrating this render must
  // agree with it, so there the remembered tab is read after hydration.
  // Mounted in a page that is already running (a client-side navigation),
  // it opens on the remembered tab straight away rather than flashing the URL
  // one first.
  const hydrated = useHydrated();
  const [tab, setTab] = useState<SaveTab>(() => (hydrated ? storedTab() : undefined) ?? "url");
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<MarkdownImportValues>(NO_MARKDOWN);
  const [markdownProblems, setMarkdownProblems] = useState<MarkdownImportProblems>({});
  const [refused, setRefused] = useState<Refusal | null>(null);
  /** Which tab's request the refusal answered: an import words its 503 as one. */
  const [refusedFor, setRefusedFor] = useState<SaveTab>("url");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const markdownFormRef = useRef<MarkdownImportFormHandle>(null);
  // A second submit while the first is in flight, or held paused offline,
  // would claim the URL twice. Cleared only once the save has settled. One
  // guard for both tabs: a save and an import are the same kind of write.
  const submittingRef = useRef(false);

  useEffect(() => {
    // The hydrating render's catch-up; a client-side mount already has it.
    const remembered = storedTab();
    if (remembered) setTab(remembered);
  }, []);

  function selectTab(next: SaveTab) {
    setTab(next);
    rememberTab(next);
  }

  const save = useMutation({
    mutationFn: (request: CaptureRequest) =>
      request.kind === "url"
        ? submitReading(queryClient, request.url, expectedTenant)
        : importMarkdown(queryClient, request.body, expectedTenant),
  });

  function reject(message: string) {
    setProblem(message);
    inputRef.current?.focus();
  }

  function rejectMarkdown(problems: MarkdownImportProblems) {
    setMarkdownProblems(problems);
    const first = firstProblemField(problems);
    if (first) markdownFormRef.current?.focus(first);
  }

  /** The field a reader goes back to when the notice they pressed goes away. */
  function focusForm(kind: SaveTab) {
    if (kind === "url") inputRef.current?.focus();
    else markdownFormRef.current?.focus("sourceUrl");
  }

  /** The request this tab's fields make, or undefined after rejecting them in place. */
  function requestFor(kind: SaveTab): CaptureRequest | undefined {
    if (kind === "url") {
      const value = url.trim();
      const rejected = saveUrlProblem(value);
      if (rejected === undefined) return { kind: "url", url: value };
      // Nothing is asked for: the reader is returned to the field with the
      // reason, and the URL stays exactly as they typed it.
      reject(rejected);
      return undefined;
    }
    const problems = markdownImportProblems(markdown);
    if (firstProblemField(problems) === undefined) return { kind: "markdown", body: markdownImportBody(markdown) };
    // The same, field by field: focus goes to the first one refused, and
    // everything typed — the Markdown above all — stays where it was.
    rejectMarkdown(problems);
    return undefined;
  }

  /**
   * The one way a save is made: the fields' rules first, then the request.
   * Either form's submit and a notice's retry both come through here, so a
   * retry cannot get past a rule a submit would have caught. A retry asks
   * again for the tab on screen, which is the form the reader can see.
   *
   * The outcome is handled in `mutate`'s own callbacks rather than the
   * mutation's, because query-core keeps a paused mutation in the cache after
   * this page is gone and would otherwise resume it, navigate, and pull the
   * reader off whatever they are reading. Per-call callbacks are skipped once
   * the observer has unsubscribed, so a save that resumes without this page
   * still reaches the backend and simply lands in the library.
   */
  function trySubmit(kind: SaveTab) {
    if (submittingRef.current) return;
    // The notice that asked for this is about to go, and with it the button
    // the reader pressed; focus goes back to the form, where its own
    // rejection also puts it, rather than falling to the document.
    if (document.activeElement?.closest(".offline-notice")) focusForm(kind);
    // What the last save answered is stale the moment another is asked for,
    // including when this one never leaves: a field error beside a notice
    // still offering to retry the URL it just refused says two things at once.
    save.reset();
    setProblem(null);
    setMarkdownProblems({});
    setRefused(null);
    setAnnouncement(null);
    const request = requestFor(kind);
    if (request === undefined) return;
    submittingRef.current = true;
    save.mutate(request, {
      onSuccess: async (outcome) => {
        if (outcome.kind === "invalid") {
          // The backend's rejection is the field's error, and the reader is
          // put back in the field to fix it, as the client-side rule does.
          // For an import that is the source URL: the rules already cover
          // everything else the backend would refuse. A reader who switched
          // tabs while it was out is taken back to the form it rejected,
          // rendered now so its field is there to take the focus.
          flushSync(() => selectTab(request.kind));
          if (request.kind === "url") reject(outcome.message);
          else rejectMarkdown({ sourceUrl: outcome.message });
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
          setRefusedFor(request.kind);
          setAnnouncement(noticeSentence(outcome, request.kind) ?? null);
          return;
        }
        // Politely, and without taking focus: the route change moves focus to
        // the reading's heading, which is where the reader is going. A URL
        // already in the library was not saved now, so it does not say so.
        setAnnouncement(
          outcome.kind === "existing"
            ? "Opening the reading…"
            : request.kind === "url"
              ? "Saved. Opening the reading…"
              : "Imported. Opening the reading…",
        );
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
    trySubmit("url");
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
            <SaveNoticeBanner notice={current.notice} action={refusedFor} onRetry={() => trySubmit(tab)} />
            {/* The form is a card (design spec, Forms/status cards), with the
                tabs inside it as in the accepted prototype. */}
            <div className="save-card">
              <ViewTabs label="What to save" idPrefix="save" tabs={SAVE_TABS} selected={tab} onSelect={selectTab}>
                {/* The browser's own URL check would replace our message with
                    its bubble, which is neither in the page nor linked to the
                    field. */}
                {tab === "url" ? (
                  <form className="save-form" onSubmit={onSubmit} noValidate>
                    <TextField label="URL" problem={problem}>
                      {(control) => (
                        <input
                          {...control}
                          ref={inputRef}
                          className="text-input"
                          type="text"
                          inputMode="url"
                          name="url"
                          autoComplete="url"
                          spellCheck={false}
                          value={url}
                          onChange={(event) => setUrl(event.target.value)}
                        />
                      )}
                    </TextField>
                    <div className="form-actions">
                      {/* aria-disabled, not disabled: a disabled button is blurred
                          by the browser, and the reader would lose their place
                          while the save runs — and with it the focus the state
                          page takes when one replaces this form. The submit is
                          refused by submittingRef either way. */}
                      <button
                        type="submit"
                        className="button button-primary button-leading-icon"
                        aria-disabled={save.isPending || undefined}
                      >
                        <Icon name="plus" size={16} strokeWidth={2} />
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <MarkdownImportForm
                    ref={markdownFormRef}
                    values={markdown}
                    problems={markdownProblems}
                    onChange={setMarkdown}
                    onSubmit={() => trySubmit("markdown")}
                    pending={save.isPending}
                  />
                )}
              </ViewTabs>
            </div>
            {/* The page's standing polite region: on screen before there is
                anything to say, so what lands in it is announced. A refusal's
                sentence comes through here too, which is why its notice is
                not a second region, and why the region is only heard while
                that notice is on screen: sighted readers would get the
                sentence twice. */}
            <p className={refused ? "form-status visually-hidden" : "form-status"} role="status">
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

/**
 * What a notice says, in one place: the banner renders it, and the page's
 * live region announces it, and the reader must not be given two wordings of
 * the same refusal. Offline keeps its own sentences in the shared notice.
 */
function noticeSentence(notice: SaveNotice | Refusal, action: SaveTab): string | undefined {
  switch (notice.kind) {
    case "limited":
    case "guard-unavailable":
    case "unavailable":
      return captureRefusalSentence(notice, unavailableSentence(action));
    case "already-processing":
      return ALREADY_PROCESSING_SENTENCE;
    default:
      return undefined;
  }
}

/** A 503 names what could not be done (capture-refusal.ts), in the words of the button the reader pressed. */
function unavailableSentence(action: SaveTab): string {
  return action === "url" ? "Saving is unavailable right now." : "Importing is unavailable right now.";
}

/**
 * The notice above the form, with a way on only when there is one to offer.
 * The 503's operator-facing error string is not shown; the reading it names,
 * when it names one, is worth opening.
 *
 * Offline keeps the shared default live region, as the library's does.
 */
function SaveNoticeBanner({
  notice,
  action,
  onRetry,
}: {
  notice: SaveNotice;
  /** The tab whose request was refused. */
  action: SaveTab;
  onRetry: () => void;
}) {
  switch (notice.kind) {
    case "none":
      return null;
    case "offline-paused":
      return <OfflineNotice message="You're offline. This save will be sent when your connection returns." />;
    case "offline-failed":
      return <OfflineNotice onRetry={onRetry} />;
    case "already-processing":
      // An attempt already running is the backend's to finish, and asking
      // again while it runs gets the same answer: the notice says so and
      // offers nothing.
      return <InlineNotice message={ALREADY_PROCESSING_SENTENCE} live={false} />;
    default:
      return (
        <CaptureRefusalNotice refusal={notice} unavailable={unavailableSentence(action)} onTryAgain={onRetry}>
          {notice.kind === "unavailable" && notice.id ? (
            <Link className="notice-link" to="/readings/$id" params={{ id: notice.id }}>
              Open the reading
            </Link>
          ) : null}
        </CaptureRefusalNotice>
      );
  }
}
