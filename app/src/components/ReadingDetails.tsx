import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { fetchFile } from "../api/files";
import { diagnosticsQueryOptions } from "../diagnostics-query";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, type Reading } from "../reading";
import {
  attemptStatusLabel,
  attemptTriggerLabel,
  byteSize,
  eventStatusLabel,
  objectName,
  pointerVerdict,
  similarityFacts,
  type AttemptEvent,
  type AttemptLog,
  type Diagnostics,
  type Fact,
} from "../reading-diagnostics";
import {
  FILE_LABELS,
  fileProblem,
  offeredFiles,
  openFileTab,
  showFile,
  type FileKind,
  type FileTab,
} from "../reading-files";
import { dateTimeOn } from "../reading-presentation";
import { DelayedText } from "./ReadingStates";

// The Details section (#373; design spec, Reading surface: "Details is one
// collapsed disclosure holding keywords, people, organizations, similarity
// numbers, 'Open as file' for extracted and raw content, attempts, and
// diagnostics. Diagnostics load only when opened.").
//
// A native <details>, so it is collapsed in the server render and operable
// from the keyboard without any script. The manifest's own fields (entities,
// similarity) are in the HTML from the start; diagnostics and the attempts
// they carry are requested only once the reader opens the section, and the
// files only when their buttons are pressed. Everything below the summary is
// what the backend reported, labelled by fixed rules in reading-diagnostics.ts.
//
// The element stays uncontrolled: React only latches that it has been opened,
// which is all the diagnostics query needs. A reader can open it before the
// bundle hydrates, and that toggle fires with no listener attached, so the
// latch also reads the element on mount. ReadingPage keys this component on
// the reading id, so the latch starts closed for each reading.

export function ReadingDetails({ reading }: { reading: Reading }) {
  const element = useRef<HTMLDetailsElement>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (element.current?.open) setOpened(true);
  }, []);
  function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) setOpened(true);
  }
  return (
    <details ref={element} className="reading-details" onToggle={onToggle}>
      <summary className="reading-details-summary">
        <h2>Details</h2>
      </summary>
      <div className="reading-details-body">
        <Entities heading="Keywords" values={reading.keywords} />
        <Entities heading="People" values={reading.people} />
        <Entities heading="Organizations" values={reading.orgs} />
        <Similarity reading={reading} />
        <Files reading={reading} />
        <DiagnosticsBlock reading={reading} opened={opened} />
      </div>
    </details>
  );
}

/** Keywords, people, organizations (design spec, Data mapping): plain lists, omitted when empty. */
function Entities({ heading, values }: { heading: string; values: string[] | undefined }) {
  if (!values || values.length === 0) return null;
  return (
    <section className="reading-details-group">
      <h3>{heading}</h3>
      <ul className="reading-details-chips" aria-label={heading}>
        {values.map((value) => (
          <li key={value} className="chip">
            {value}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The numbers behind the novelty verdict; the panel itself never shows them. */
function Similarity({ reading }: { reading: Reading }) {
  const facts = similarityFacts(reading.similarity);
  if (facts.length === 0) return null;
  return (
    <section className="reading-details-group">
      <h3>Similarity</h3>
      <FactList facts={facts} />
    </section>
  );
}

function FactList({ facts }: { facts: Fact[] }) {
  return (
    <dl className="reading-details-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="reading-details-fact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Open as file" (acceptance matrix: Open extracted Markdown, Open raw
 * capture). The tab opens on the click and waits; the bytes follow through a
 * mutation rather than a query, since they are opened, not rendered, and a
 * 401 on the way still reaches the shell's session-ended page through the
 * mutation cache (src/auth/session.ts). A tab that got no file is closed.
 */
function Files({ reading }: { reading: Reading }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const [problem, setProblem] = useState<string | undefined>();
  const opening = useMutation({
    mutationFn: ({ kind }: { kind: FileKind; tab: FileTab | null }) =>
      fetchFile(queryClient, reading.id, kind, expectedLayoutOf(identity)),
    onMutate: () => setProblem(undefined),
    onSuccess: (result, { tab }) => {
      if (result.state === "ready" && tab) showFile(tab, result.bytes, window);
      else if (result.state !== "ready") setProblem(fileProblem(result));
    },
    onError: (error) => setProblem(`The file couldn't be loaded. ${error.message}`),
    onSettled: (result, _error, { tab }) => {
      if (result?.state !== "ready") tab?.close();
    },
  });
  return (
    <section className="reading-details-group">
      <h3>Files</h3>
      <div className="form-actions">
        {offeredFiles(reading).map((kind) => (
          <button
            key={kind}
            type="button"
            className="button"
            disabled={opening.isPending}
            onClick={() => opening.mutate({ kind, tab: openFileTab(window) })}
          >
            {FILE_LABELS[kind]}
          </button>
        ))}
      </div>
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** Diagnostics and attempts, requested once the section has been opened. */
function DiagnosticsBlock({ reading, opened }: { reading: Reading; opened: boolean }) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, isPending, refetch } = useQuery({
    ...diagnosticsQueryOptions(queryClient, reading.id, identity),
    enabled: opened,
  });
  return (
    <section className="reading-details-group" aria-labelledby="diagnostics-heading">
      <h3 id="diagnostics-heading">Diagnostics</h3>
      {data?.state === "forbidden" ? (
        <p className="form-hint">You don't have access to this reading's diagnostics.</p>
      ) : data?.state === "account-changed" ? (
        <p className="form-hint">
          This tab is signed in to a different account than the page expects. Reload to continue as the account
          signed in now.
        </p>
      ) : data?.state === "ready" ? (
        <DiagnosticsLoaded diagnostics={data.diagnostics} />
      ) : error ? (
        <div className="reading-details-failed">
          <p>Diagnostics couldn't be loaded. {error.message}</p>
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        </div>
      ) : isPending && opened ? (
        <div className="reading-details-loading" aria-busy="true">
          <DelayedText delayMs={300}>Loading diagnostics…</DelayedText>
        </div>
      ) : null}
    </section>
  );
}

function DiagnosticsLoaded({ diagnostics }: { diagnostics: Diagnostics }) {
  const facts: Fact[] = [
    { label: "Storage key", value: diagnostics.key_prefix },
    { label: "By-id pointer", value: pointerVerdict(diagnostics.pointers.by_id) },
    { label: "By-URL pointer", value: pointerVerdict(diagnostics.pointers.by_url) },
    { label: "Library row", value: diagnostics.index_item?.status ?? "Missing" },
  ];
  return (
    <>
      <FactList facts={facts} />
      <h4>Objects</h4>
      {diagnostics.objects.length === 0 ? (
        <p className="form-hint">No objects.</p>
      ) : (
        <ul className="reading-details-objects">
          {diagnostics.objects.map((object) => {
            const size = byteSize(object.size);
            return (
              <li key={object.key}>
                <code>{objectName(object.key, diagnostics.key_prefix)}</code>
                {size ? <span className="reading-details-size">{size}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <h4>Attempts</h4>
      {diagnostics.attempts.length === 0 ? (
        <p className="form-hint">No attempts recorded.</p>
      ) : (
        <ol className="reading-details-attempts">
          {diagnostics.attempts.map((attempt) => (
            <li key={attempt.id}>
              <Attempt attempt={attempt} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * One attempt: what started it, how it ended, when, its error if it failed,
 * and its stage events behind a nested disclosure so a long log does not
 * swamp the section. Stages keep their backend names here: the status card's
 * coarse labels fold several stages into one word, and a log whose rows
 * cannot be told apart is no use to the operator reading it.
 */
function Attempt({ attempt }: { attempt: AttemptLog }) {
  const started = dateTimeOn(attempt.started_at);
  const finished = dateTimeOn(attempt.finished_at);
  const stage = attempt.stage;
  const events = attempt.events ?? [];
  return (
    <article className="reading-details-attempt" aria-label={`${attemptTriggerLabel(attempt.trigger)} attempt`}>
      <p className="reading-details-attempt-line">
        <strong>{attemptTriggerLabel(attempt.trigger)}</strong>
        <span className={attempt.status === "failed" ? "reading-details-status-failed" : undefined}>
          {attemptStatusLabel(attempt.status)}
        </span>
        {stage ? <code>{stage}</code> : null}
      </p>
      <p className="form-hint">
        {started ? `Started ${started}` : null}
        {started && finished ? " · " : null}
        {finished ? `Finished ${finished}` : null}
      </p>
      {attempt.error ? <p className="reading-details-error">{attempt.error.message}</p> : null}
      {events.length > 0 ? (
        <details className="reading-details-events">
          <summary>
            {events.length} {events.length === 1 ? "step" : "steps"}
          </summary>
          <ol>
            {events.map((event, index) => (
              <li key={`${event.stage}-${event.status}-${index}`}>
                <Event event={event} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

function Event({ event }: { event: AttemptEvent }) {
  return (
    <>
      <code>{event.stage}</code>
      <span>{eventStatusLabel(event.status)}</span>
      {event.duration_ms !== undefined ? <span className="reading-details-size">{event.duration_ms} ms</span> : null}
      {event.error ? <span className="reading-details-error">{event.error.message}</span> : null}
    </>
  );
}
