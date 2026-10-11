import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, type ReactNode } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import { whoamiQueryKey, type Identity } from "../identity";
import { dateOn, hostnameOf, savedOn } from "../reading-presentation";
import { tensionKindLabel } from "../reading-relationships";
import type { GraphReading, RelationshipGraph } from "../relationships";
import { relationshipsQueryOptions } from "../relationships-query";
import { rowsWithin, standingAlone, tensionPairs, threadFor, threadsOf, type Thread } from "../threads";
import { BackToLibrary } from "./BackToLibrary";
import { PageHeading, PageStateFocus } from "./PageHeading";
import { AccountChanged, Forbidden, LoadingRegion, OfflineNotice, ServerError, ThreadNotFound } from "./ReadingStates";

// The Threads pages (reading-lite-kl7y.3; design spec, Threads and Tension
// pairs). Both read the tenant's relationship graph, server-rendered by their
// loaders, and derive everything else in threads.ts. /threads lists the
// threads most recently extended first, then the library's tension pairs,
// then the ready readings that stand alone. /threads/$id is one thread,
// oldest first, with the connections and tensions between its readings.
// The account page's common states (account-state.ts) replace either page.

function useRelationships() {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus, refetch } = useQuery(relationshipsQueryOptions(queryClient, identity));
  return { view: accountViewOf({ data, error, fetchStatus }), onRetry: () => void refetch() };
}

/** The common states, or `page` with whatever graph has loaded. */
function pageFor(
  view: AccountView<RelationshipGraph>,
  onRetry: () => void,
  page: (graph: RelationshipGraph | undefined, notice: ReactNode) => ReactNode,
) {
  switch (view.kind) {
    case "forbidden":
      return (
        <Forbidden>
          <div className="form-actions">
            <BackToLibrary className="button" />
          </div>
        </Forbidden>
      );
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

export function ThreadsPage() {
  const { view, onRetry } = useRelationships();
  return (
    <PageStateFocus kind={view.kind}>
      {pageFor(view, onRetry, (graph, notice) => (
        <div className="page threads">
          <PageHeading>Threads</PageHeading>
          <p className="auth-lede">
            Readings grouped by the connections and tensions between them, oldest first, so each thread reads as
            the argument you built.
          </p>
          {notice}
          {graph ? <ThreadsOf graph={graph} /> : null}
        </div>
      ))}
    </PageStateFocus>
  );
}

function ThreadsOf({ graph }: { graph: RelationshipGraph }) {
  const threads = useMemo(() => threadsOf(graph), [graph]);
  const pairs = useMemo(() => tensionPairs(graph), [graph]);
  const alone = useMemo(() => standingAlone(graph, threads), [graph, threads]);
  const tensionsId = useId();
  const aloneId = useId();
  return (
    <>
      {threads.length === 0 ? (
        <div className="library-message">
          <p className="auth-lede">No threads yet. Threads form as readings connect.</p>
          <BackToLibrary className="button" />
        </div>
      ) : (
        <ul className="thread-list" aria-label="Threads">
          {threads.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} />
          ))}
        </ul>
      )}
      {pairs.length > 0 ? (
        <section className="threads-section" aria-labelledby={tensionsId}>
          <h2 id={tensionsId} className="threads-section-title">
            Tensions
          </h2>
          <p className="form-hint">Where your readings disagree, qualify, or supersede one another.</p>
          <ul className="tension-list" aria-label="Tensions">
            {pairs.map((pair) => (
              <li key={`${pair.a.id}|${pair.b.id}`} className="tension-pair">
                <p className="tension-pair-titles">
                  <ReadingLink reading={pair.a} />
                  <span className="tension-kind">{pair.label}</span>
                  <ReadingLink reading={pair.b} />
                </p>
                <p className="relationship-reason">{pair.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {alone.length > 0 ? (
        <section className="threads-section" aria-labelledby={aloneId}>
          <h2 id={aloneId} className="threads-section-title">
            Standing alone
          </h2>
          <p className="form-hint">Ready readings with no connection or tension yet.</p>
          <ul className="library-list" aria-label="Readings standing alone">
            {alone.map((reading) => (
              <li key={reading.id} className="library-card">
                <h3 className="library-card-title">
                  <ReadingLink reading={reading} />
                </h3>
                <p className="reading-meta library-card-meta">
                  <span>{hostnameOf(reading.url)}</span>
                  {savedOn(reading.created_at) ? <span>{savedOn(reading.created_at)}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "3 March 2026 to 1 September 2026", or the one date when both ends share it. */
function spanOf(thread: Thread): string | undefined {
  const first = dateOn(thread.readings[0]!.created_at);
  const last = dateOn(thread.updatedAt);
  if (!first || !last) return first ?? last;
  return first === last ? first : `${first} to ${last}`;
}

function ThreadCard({ thread }: { thread: Thread }) {
  const preview = thread.readings.slice(0, 3);
  const span = spanOf(thread);
  return (
    <li className="thread-card">
      <h2 className="thread-card-title">
        <Link to="/threads/$id" params={{ id: thread.id }}>
          {thread.name}
        </Link>
      </h2>
      <p className="reading-meta library-card-meta">
        <span>{plural(thread.readings.length, "reading")}</span>
        <span>{plural(thread.tensions, "tension")}</span>
        {span ? <span>{span}</span> : null}
      </p>
      <ol className="thread-chain">
        {preview.map((reading) => (
          <li key={reading.id}>{reading.title ?? reading.url}</li>
        ))}
        {thread.readings.length > preview.length ? (
          <li className="thread-chain-more">and {thread.readings.length - preview.length} more</li>
        ) : null}
      </ol>
    </li>
  );
}

function ReadingLink({ reading }: { reading: GraphReading }) {
  return (
    <Link to="/readings/$id" params={{ id: reading.id }}>
      {reading.title ?? reading.url}
    </Link>
  );
}

export function ThreadPage({ id }: { id: string }) {
  const { view, onRetry } = useRelationships();
  return (
    <PageStateFocus kind={view.kind}>
      {pageFor(view, onRetry, (graph, notice) =>
        graph ? (
          <ThreadOf graph={graph} id={id} notice={notice} />
        ) : (
          <div className="page threads">
            <PageHeading>Thread</PageHeading>
            {notice}
          </div>
        ),
      )}
    </PageStateFocus>
  );
}

function ThreadOf({ graph, id, notice }: { graph: RelationshipGraph; id: string; notice: ReactNode }) {
  const thread = useMemo(() => threadFor(threadsOf(graph), id), [graph, id]);
  if (!thread) return <ThreadNotFound id={id} />;
  const titles = new Map(graph.readings.map((reading) => [reading.id, reading.title ?? reading.url]));
  const first = thread.readings[0]!;
  const span = spanOf(thread);
  return (
    <div className="page threads thread-page">
      <div className="reading-head reading-head-actions">
        <PageHeading>{thread.name}</PageHeading>
        <p className="reading-meta">
          <span>{plural(thread.readings.length, "reading")}</span>
          <span>{plural(thread.tensions, "tension")}</span>
          {span ? <span>{span}</span> : null}
        </p>
        <div className="reading-actions">
          <Link to="/readings/$id" params={{ id: first.id }} className="button">
            Start at the beginning
          </Link>
        </div>
      </div>
      {notice}
      <ol className="thread-rail" aria-label={`Readings in ${thread.name}`}>
        {thread.readings.map((reading) => {
          const rows = rowsWithin(graph, thread, reading.id);
          return (
            <li key={reading.id} className="thread-entry">
              <p className="thread-entry-date">{dateOn(reading.created_at)}</p>
              <h2 className="thread-entry-title">
                <ReadingLink reading={reading} />
              </h2>
              <p className="thread-entry-meta">{hostnameOf(reading.url)}</p>
              {rows.length > 0 ? (
                <ul className="thread-links">
                  {rows.map((row) => (
                    <li
                      key={`${row.kind}:${row.target_id}`}
                      className={row.kind === "tension" ? "thread-link-row thread-link-tension" : "thread-link-row"}
                    >
                      <span className="relationship-kind">
                        {row.kind === "tension" ? tensionKindLabel(row.tension_kind ?? "tension") : "Connects to"}
                      </span>{" "}
                      <Link to="/readings/$id" params={{ id: row.target_id }}>
                        {titles.get(row.target_id)}
                      </Link>
                      <span className="thread-link-reason">{row.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
