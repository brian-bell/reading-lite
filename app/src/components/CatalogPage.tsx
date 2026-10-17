import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { NetworkError } from "../api/errors";
import { accountViewOf, type AccountView } from "../account-state";
import {
  KINDS,
  TERM_KINDS,
  catalogEmptyCopy,
  catalogListParams,
  catalogSearchOf,
  catalogViewOf,
  type CatalogIndex,
  type CatalogListView,
  type CatalogSearch,
  type CatalogView,
  type TermKind,
} from "../catalog";
import { catalogIndexQueryOptions } from "../catalog-query";
import { captureRefusalSentence } from "../capture-refusal";
import { whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import type { LibraryResult } from "../library";
import { libraryQueryOptions } from "../library-query";
import { originReturnState } from "../library-return";
import { libraryViewOf, type LibraryView } from "../library-state";
import type { Failure } from "../reading-failure";
import {
  MEANING_QUESTION_MAX,
  meaningQuestionOf,
  meaningQuestionOfState,
  meaningState,
  type MeaningOutcome,
  type MeaningQuestion,
  type MeaningResult,
  type MeaningView,
} from "../similar-readings";
import { runMeaningSearch, useMeaningResult } from "../similar-readings-query";
import { librarySchedule } from "../status-refresh";
import { CaptureRefusalNotice } from "./CaptureNotice";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { LibraryRows, libraryWatchKeyOf, useGraphRefreshOnSettle, useScrollRestoredOnceRowsArrive } from "./LibraryPage";
import { PAGE_LINK_ACTIVE, Pager } from "./Pager";
import { AccountChanged, Forbidden, InlineNotice, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";
import { useRenderedLocation } from "./rendered-location";
import { useStatusWatch } from "./use-status-watch";
import { ViewTabs } from "./ViewTabs";

export function CatalogHome({ search }: { search: CatalogSearch }) {
  const { data: identity } = useQuery(whoamiQueryOptions());
  if (!identity) {
    return (
      <div className="page">
        <PageHeading>Catalog</PageHeading>
      </div>
    );
  }
  return <CatalogPage search={search} />;
}

/**
 * A question asked by meaning lives in the history entry, not the URL
 * (similar-readings.ts), so the entry decides the screen before the URL does.
 * The polite region stands above whichever screen is up, so it is on the page
 * before there is anything to say.
 */
function CatalogPage({ search }: { search: CatalogSearch }) {
  const question = useRenderedLocation((location) => meaningQuestionOfState(location.state));
  const view = catalogViewOf(search);
  return (
    <>
      <MeaningAnnouncement question={question} />
      {question !== undefined ? (
        <MeaningResults search={search} question={question} />
      ) : view.mode === "index" ? (
        <CatalogIndex search={search} kind={view.kind} />
      ) : (
        <CatalogResults search={search} view={view} />
      )}
    </>
  );
}

const MEANING_EMPTY = "Nothing in your library is close to that.";
const MEANING_UNAVAILABLE = "Meaning search didn't answer.";

function MeaningAnnouncement({ question }: { question: MeaningQuestion | undefined }) {
  const meaning = useMeaningResult(question);
  return (
    <p className="visually-hidden" role="status">
      {meaning.state === "done" ? meaningSentence(meaning.outcome) : null}
    </p>
  );
}

function meaningSentence(outcome: MeaningOutcome): string | null {
  switch (outcome.kind) {
    case "results": {
      const n = outcome.items.length;
      return n === 0 ? MEANING_EMPTY : `${n} ${n === 1 ? "reading" : "readings"} close to that.`;
    }
    case "refusal":
      return captureRefusalSentence(outcome.refusal, MEANING_UNAVAILABLE);
    case "failure":
      return failureSentence(outcome.failure);
    case "forbidden":
    case "account-changed":
      return null;
  }
}

function failureSentence(failure: Failure): string {
  return failure.next ? `${failure.headline} ${failure.next}` : failure.headline;
}

function MeaningResults({ search, question }: { search: CatalogSearch; question: MeaningQuestion }) {
  const queryClient = useQueryClient();
  const meaning = useMeaningResult(question);
  // Asking again spends again, so only the reader's own press does it.
  const ask = () => void runMeaningSearch(queryClient, queryClient.getQueryData<Identity | null>(whoamiQueryKey), question);
  const asText = catalogSearchOf(viewForQuery(catalogViewOf(search), question));
  return (
    <PageStateFocus kind={meaning.state === "done" ? meaning.outcome.kind : meaning.state}>
      {meaningPage(meaning, ask, asText, (body) => (
        <div className="page catalog">
          <PageHeading>Catalog</PageHeading>
          <CatalogFind search={search} question={question} />
          <div className="catalog-results">
            <h2 className="catalog-heading">Close to “{question}”</h2>
            {body}
          </div>
        </div>
      ))}
    </PageStateFocus>
  );
}

function meaningPage(
  meaning: MeaningView,
  onAsk: () => void,
  asText: CatalogSearch,
  page: (body: ReactNode) => ReactNode,
) {
  switch (meaning.state) {
    case "idle":
      return page(null);
    case "running":
      return page(<LoadingRegion className="library-message" />);
    case "offline":
      return page(<OfflineNotice onRetry={onAsk} />);
    case "failed":
      return <ServerError message={meaning.message} onRetry={onAsk} />;
    case "done":
      return outcomePage(meaning.outcome, onAsk, asText, page);
  }
}

function outcomePage(
  outcome: MeaningOutcome,
  onAsk: () => void,
  asText: CatalogSearch,
  page: (body: ReactNode) => ReactNode,
) {
  switch (outcome.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={outcome.actingTenant} />;
    case "refusal":
      return page(<CaptureRefusalNotice refusal={outcome.refusal} unavailable={MEANING_UNAVAILABLE} onTryAgain={onAsk} />);
    case "failure":
      return page(<MeaningFailure failure={outcome.failure} onTryAgain={onAsk} />);
    case "results":
      return page(outcome.items.length === 0 ? <MeaningEmpty asText={asText} /> : <MeaningList items={outcome.items} />);
  }
}

function MeaningFailure({ failure, onTryAgain }: { failure: Failure; onTryAgain: () => void }) {
  return (
    <InlineNotice
      message={failureSentence(failure)}
      actionLabel="Try again"
      onAction={failure.settings ? undefined : onTryAgain}
      live={false}
    >
      {failure.settings ? (
        <Link to="/account/provider" className="button button-primary">
          {failure.settings}
        </Link>
      ) : null}
    </InlineNotice>
  );
}

function MeaningEmpty({ asText }: { asText: CatalogSearch }) {
  return (
    <div className="library-message">
      <p className="auth-lede">{MEANING_EMPTY}</p>
      <div className="form-actions">
        <Link to="/catalog" search={asText} className="button">
          Try a text search
        </Link>
      </div>
    </div>
  );
}

function MeaningList({ items }: { items: readonly MeaningResult[] }) {
  return (
    <ul className="catalog-entries meaning-results" aria-label="Readings">
      {items.map((item) => (
        <li key={item.id} className="catalog-entry">
          <Link to="/readings/$id" params={{ id: item.id }} state={originReturnState("catalog")} className="catalog-term">
            {item.title}
          </Link>
          <span className={`closeness closeness-${item.closeness.toLowerCase()}`}>{item.closeness}</span>
        </li>
      ))}
    </ul>
  );
}

function CatalogIndex({ search, kind }: { search: CatalogSearch; kind: TermKind }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(catalogIndexQueryOptions(queryClient, identity));
  const view = accountViewOf({ data, error, fetchStatus });
  const retry = () => void refetch();
  return (
    <PageStateFocus kind={view.kind}>
      {indexPage(view, retry, (index, notice) => (
        <div className="page catalog">
          <PageHeading>Catalog</PageHeading>
          <CatalogFind search={search} />
          {notice}
          {index ? <CatalogTabs kind={kind} index={index} /> : null}
        </div>
      ))}
    </PageStateFocus>
  );
}

function indexPage(
  view: AccountView<CatalogIndex>,
  onRetry: () => void,
  page: (index: CatalogIndex | undefined, notice: ReactNode) => ReactNode,
) {
  switch (view.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={onRetry} />;
    case "offline":
      return page(view.value, <OfflineNotice onRetry={onRetry} />);
    case "loading":
      return page(undefined, <LoadingRegion className="library-message" />);
    case "ready":
      return page(view.value, null);
  }
}

function CatalogTabs({ kind, index }: { kind: TermKind; index: CatalogIndex }) {
  const navigate = useNavigate();
  const entries = index[kind];
  return (
    <ViewTabs
      label="Index"
      idPrefix="catalog"
      tabs={TERM_KINDS.map((key) => ({ key, label: `${KINDS[key].label} ${index[key].length}` }))}
      selected={kind}
      onSelect={(next) => {
        void navigate({
          to: "/catalog",
          search: catalogSearchOf({ mode: "index", kind: next }),
          replace: true,
        });
      }}
    >
      {entries.length === 0 ? (
        <p className="auth-lede">No {kind} yet.</p>
      ) : (
        <ul className="catalog-entries" aria-label={KINDS[kind].label}>
          {entries.map((entry) => (
            <li key={entry.term} className="catalog-entry">
              <Link
                to="/catalog"
                search={catalogSearchOf({ mode: "term", facet: { kind, term: entry.term }, offset: 0 })}
                className="catalog-term"
              >
                {entry.term}
              </Link>
              <span className="catalog-count">{entry.count}</span>
            </li>
          ))}
        </ul>
      )}
    </ViewTabs>
  );
}

function CatalogResults({ search, view }: { search: CatalogSearch; view: CatalogListView }) {
  const params = catalogListParams(view);
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const watch = useStatusWatch<LibraryResult>({ keyOf: libraryWatchKeyOf, schedule: librarySchedule });
  const { data, error, fetchStatus, refetch } = useQuery(
    libraryQueryOptions(queryClient, params, identity, watch.options),
  );
  useGraphRefreshOnSettle(data);
  const checkFailed =
    (watch.status === "watching" || watch.status === "failures") && !(error instanceof NetworkError && error.offline);
  const list = libraryViewOf({ data, error: checkFailed ? null : error, fetchStatus });
  const stoppedChecking = watch.status === "failures" && error !== null;
  const retry = () => void refetch();
  return (
    <PageStateFocus kind={list.kind}>
      {resultsPage(list, view, search, retry, stoppedChecking)}
    </PageStateFocus>
  );
}

function resultsPage(
  list: LibraryView,
  view: CatalogListView,
  search: CatalogSearch,
  retry: () => void,
  stoppedChecking: boolean,
) {
  switch (list.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={list.actingTenant} />;
    case "server-error":
      return <ServerError message={list.message} onRetry={retry} />;
    default:
      return (
        <div className="page catalog">
          <PageHeading>Catalog</PageHeading>
          <CatalogFind search={search} />
          <CatalogList view={view} search={search} list={list} onRetry={retry} stoppedChecking={stoppedChecking} />
        </div>
      );
  }
}

function CatalogList({
  view,
  search,
  list,
  onRetry,
  stoppedChecking,
}: {
  view: CatalogListView;
  search: CatalogSearch;
  list: Extract<LibraryView, { kind: "loading" | "offline" | "ready" }>;
  onRetry: () => void;
  stoppedChecking: boolean;
}) {
  const page = list.kind === "loading" ? undefined : list.page;
  const empty = page !== undefined && page.readings.length === 0;
  useScrollRestoredOnceRowsArrive(list.kind === "loading", page !== undefined);
  return (
    <div className="catalog-results">
      <h2 className="catalog-heading">{view.mode === "term" ? view.facet.term : `Matching “${view.q}”`}</h2>
      {list.kind === "offline" ? <OfflineNotice onRetry={onRetry} /> : null}
      {list.kind === "ready" && stoppedChecking ? <InlineNotice message="Couldn't check status." live={false} /> : null}
      {list.kind === "loading" ? <LoadingRegion className="library-message" /> : null}
      {page === undefined ? null : empty ? (
        <EmptyCatalog view={view} />
      ) : (
        <LibraryRows rows={page.readings} search={{}} origin="catalog" />
      )}
      <Pager
        to="/catalog"
        search={search}
        offset={view.offset}
        hasMore={page === undefined ? list.kind === "loading" : page.has_more}
      />
    </div>
  );
}

function EmptyCatalog({ view }: { view: CatalogListView }) {
  return (
    <div className="library-message">
      <p className="auth-lede">{catalogEmptyCopy(view)}</p>
      <div className="form-actions">
        {view.q ? (
          <Link to="/catalog" search={catalogSearchOf(withoutQuery(view))} className="button" activeOptions={PAGE_LINK_ACTIVE}>
            Clear search
          </Link>
        ) : null}
        {view.mode === "term" ? (
          <Link to="/catalog" search={catalogSearchOf(withoutFacet(view))} className="button" activeOptions={PAGE_LINK_ACTIVE}>
            Clear {view.facet.term}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

type FindMode = "text" | "meaning";

const FIND_MODES: ReadonlyArray<{ value: FindMode; label: string }> = [
  { value: "text", label: "Text" },
  { value: "meaning", label: "Meaning" },
];

/**
 * Find by text puts `q` in the URL. Find by meaning puts the question in the
 * history entry and spends once, here, on submit. The mode itself is neither:
 * it starts as whatever the screen shows. Neither the facet nor `q` narrows a
 * meaning search, so in Meaning mode their chips are hidden, but the URL keeps
 * them for Text.
 */
function CatalogFind({ search, question }: { search: CatalogSearch; question?: MeaningQuestion }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = catalogViewOf(search);
  const q = search.q?.trim() ? search.q : "";
  const asked = question ?? q;
  const [mode, setMode] = useState<FindMode>(question === undefined ? "text" : "meaning");
  const [draft, setDraft] = useState(asked);
  const [draftFor, setDraftFor] = useState(asked);
  if (draftFor !== asked) {
    setDraftFor(asked);
    setDraft(asked);
  }
  const running = useMeaningResult(question).state === "running";
  const meaning = mode === "meaning";
  const facet = view.mode === "term" ? view.facet : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!meaning) {
      const next = viewForQuery(view, draft);
      setDraft(next.mode === "index" ? "" : (next.q ?? ""));
      void navigate({ to: "/catalog", search: catalogSearchOf(next) });
      return;
    }
    // aria-disabled does not stop Enter, so the handler refuses too.
    if (running) return;
    const next = meaningQuestionOf(draft);
    if (next === undefined) return;
    // Before navigating, so the screen the navigation renders already sees
    // the request in flight rather than an unasked question.
    void runMeaningSearch(queryClient, queryClient.getQueryData<Identity | null>(whoamiQueryKey), next);
    void navigate({ to: "/catalog", search, state: meaningState(next) });
  };

  return (
    <form className="library-filters" role="search" aria-label="Find readings" onSubmit={submit}>
      <label className="field-label" htmlFor="catalog-find">
        Find
      </label>
      <div className="library-search-row">
        <input
          id="catalog-find"
          className="text-input"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={meaning ? "Describe what you're looking for" : "Title, URL, summary, keywords"}
          maxLength={meaning ? MEANING_QUESTION_MAX : undefined}
          autoComplete="off"
        />
        <button type="submit" className="button" aria-disabled={running || undefined}>
          Find
        </button>
      </div>
      <div className="find-mode" role="radiogroup" aria-labelledby="find-mode-label">
        <span id="find-mode-label" className="visually-hidden">
          Search by
        </span>
        {FIND_MODES.map((option) => (
          <label key={option.value} className="find-mode-option">
            <input
              type="radio"
              name="find-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => setMode(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {meaning ? (
        <p className="form-hint">Embeds your question with your key (a fraction of a cent) and compares it with your readings.</p>
      ) : null}
      {!meaning && (q || facet) ? (
        <p className="library-active-filters">
          <span>Filtered by</span>
          {facet ? (
            <Link
              to="/catalog"
              search={catalogSearchOf(withoutFacet(view))}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear ${facet.term}`}
            >
              {facet.term}
            </Link>
          ) : null}
          {q ? (
            <Link
              to="/catalog"
              search={catalogSearchOf(withoutQuery(view))}
              activeOptions={PAGE_LINK_ACTIVE}
              preload={false}
              className="tag tag-active"
              aria-label={`Clear search “${q}”`}
            >
              “{q}”
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

function viewForQuery(current: CatalogView, draft: string): CatalogView {
  const q = draft.trim();
  if (current.mode === "term") {
    return q ? { mode: "term", facet: current.facet, q, offset: 0 } : { mode: "term", facet: current.facet, offset: 0 };
  }
  if (q === "") return { mode: "index", kind: current.kind };
  return { mode: "text", q, kind: current.kind, offset: 0 };
}

function withoutQuery(current: CatalogView): CatalogView {
  if (current.mode === "term") return { mode: "term", facet: current.facet, offset: 0 };
  if (current.mode === "text") return { mode: "index", kind: current.kind };
  return current;
}

function withoutFacet(current: CatalogView): CatalogView {
  if (current.mode !== "term") return current;
  if (current.q) return { mode: "text", q: current.q, kind: current.facet.kind, offset: 0 };
  return { mode: "index", kind: current.facet.kind };
}
