/**
 * Threads: readings grouped by the connections and tensions between them,
 * each read oldest first as the argument the reader built, with the
 * library's tensions listed on the same page. Everything comes from the
 * connections and tensions the backend already stores; the one new read it
 * needs is the tenant's relationships as a list.
 */
import { Icon, useStudy } from "../context";
import { agoLabel, dateOn, hostOf, type Reading } from "../samples";
import { Go, LibraryCard, PageHeading } from "../shared";
import { TENSION_LABELS, revisitPrompts, tensionPairs, threadsOf, type Thread } from "../study";

export function ThreadsPage() {
  const { items } = useStudy();
  const threads = threadsOf(items);
  const pairs = tensionPairs(items);
  const inThread = new Set(threads.flatMap((t) => t.readings.map((r) => r.id)));
  const alone = items.filter((r) => r.status === "ready" && !inThread.has(r.id));
  return (
    <div className="page library">
      <PageHeading aside={<span className="page-count">{threads.length} thread{threads.length === 1 ? "" : "s"} · {pairs.length} tension{pairs.length === 1 ? "" : "s"}</span>}>Threads</PageHeading>
      <p className="auth-lede">Readings grouped by the connections and tensions between them, oldest first, so each thread reads as the argument you built.</p>
      {threads.length === 0 ? (
        <p className="library-message">Threads appear once two readings connect. {items.length === 0 ? <Go view="save">Save a reading</Go> : "Save a related reading to start one."}</p>
      ) : (
        <ul className="thread-list" aria-label="Threads">
          {threads.map((thread) => <ThreadCard key={thread.id} thread={thread} />)}
        </ul>
      )}
      <section className="threads-section" aria-labelledby="tensions-heading">
        <h2 id="tensions-heading" className="section-title">Tensions</h2>
        <p className="form-hint">Where your readings disagree, qualify, or supersede one another, as the nightly refresh judged them.</p>
        {pairs.length === 0 ? (
          <p className="library-message">No tensions yet. They are judged between readings that cover the same ground.</p>
        ) : (
          <ul className="tension-list" aria-label="Tensions">
            {pairs.map((pair) => (
              <li key={`${pair.a.id}|${pair.b.id}`} className="tension-pair">
                <p className="tension-pair-titles">
                  <Go view="reading" id={pair.a.id}>{pair.a.title}</Go>
                  <span className="tension-kind">{TENSION_LABELS[pair.kind]}</span>
                  <Go view="reading" id={pair.b.id}>{pair.b.title}</Go>
                </p>
                <p className="relationship-reason">{pair.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {alone.length > 0 ? (
        <section className="threads-section" aria-labelledby="alone-heading">
          <h2 id="alone-heading" className="section-title">On their own</h2>
          <p className="form-hint">Ready readings with no connection or tension yet.</p>
          <ul className="library-list">
            {alone.map((reading) => <LibraryCard key={reading.id} reading={reading} compact />)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ThreadCard({ thread }: { thread: Thread }) {
  const preview = thread.readings.slice(0, 3);
  return (
    <li className="thread-card">
      <h2 className="thread-card-title"><Go view="thread" id={thread.id}>{thread.name}</Go></h2>
      <p className="library-card-meta">
        <span>{thread.readings.length} readings</span>
        <span>{thread.tensions} tension{thread.tensions === 1 ? "" : "s"}</span>
        <span>Updated {dateOn(thread.updatedAt)}</span>
      </p>
      <ol className="thread-chain">
        {preview.map((reading) => <li key={reading.id}>{reading.title}</li>)}
        {thread.readings.length > preview.length ? <li className="muted">and {thread.readings.length - preview.length} more</li> : null}
      </ol>
    </li>
  );
}

export function ThreadPage() {
  const { route, items } = useStudy();
  const thread = threadsOf(items).find((t) => t.id === route.id);
  if (!thread) {
    return (
      <div className="page reading-state">
        <h1 className="page-title" tabIndex={-1}>This thread isn't here any more</h1>
        <p>Its readings may have changed. <Go view="threads">All threads</Go></p>
      </div>
    );
  }
  const ids = new Set(thread.readings.map((r) => r.id));
  const first = thread.readings[0];
  const last = thread.readings[thread.readings.length - 1];
  return (
    <div className="page thread-page">
      <PageHeading aside={<Go view="reading" id={first.id} className="button">Start at the beginning</Go>}>{thread.name}</PageHeading>
      <p className="reading-meta">
        <span>{thread.readings.length} readings</span>
        <span>{thread.tensions} tension{thread.tensions === 1 ? "" : "s"}</span>
        <span>{dateOn(first.createdAt)} to {dateOn(last.createdAt)}</span>
      </p>
      <ol className="thread-rail" aria-label={`Readings in ${thread.name}`}>
        {thread.readings.map((reading) => (
          <li key={reading.id} className="thread-entry">
            <p className="thread-entry-date">{dateOn(reading.createdAt)}</p>
            <h2 className="thread-entry-title"><Go view="reading" id={reading.id}>{reading.title}</Go></h2>
            <p className="thread-entry-meta">{hostOf(reading.url)}</p>
            {reading.tldr ? <p className="thread-entry-lead">{reading.tldr}</p> : null}
            <ul className="thread-links">
              {reading.connections.filter((c) => ids.has(c.id)).map((c) => (
                <li key={`c-${c.id}`} className="thread-link-row">
                  <span className="relationship-kind">Connects to</span>{" "}
                  <Go view="reading" id={c.id}>{titleOf(items, c.id)}</Go>
                  <span className="thread-link-reason">{c.reason}</span>
                </li>
              ))}
              {reading.tensions.filter((t) => ids.has(t.id)).map((t) => (
                <li key={`t-${t.id}`} className="thread-link-row thread-link-tension">
                  <span className="relationship-kind">{TENSION_LABELS[t.kind]}</span>{" "}
                  <Go view="reading" id={t.id}>{titleOf(items, t.id)}</Go>
                  <span className="thread-link-reason">{t.reason}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function titleOf(items: Reading[], id: string): string {
  return items.find((r) => r.id === id)?.title ?? "A removed reading";
}

/** Above the relationship cards: the thread this reading is in, with the readings either side of it. */
export function ThreadStrip({ thread, reading }: { thread: Thread; reading: Reading }) {
  const index = thread.readings.findIndex((r) => r.id === reading.id);
  const previous = thread.readings[index - 1];
  const next = thread.readings[index + 1];
  return (
    <nav className="thread-strip" aria-label="Thread">
      <p className="thread-strip-name">
        <Icon name="thread" size={14} strokeWidth={2} /> In <Go view="thread" id={thread.id}>{thread.name}</Go> · {index + 1} of {thread.readings.length}
      </p>
      <div className="thread-strip-steps">
        {previous ? <Go view="reading" id={previous.id} className="thread-step"><span className="thread-step-label">Earlier</span>{previous.title}</Go> : <span className="thread-step thread-step-empty"><span className="thread-step-label">Earlier</span>This is the first</span>}
        {next ? <Go view="reading" id={next.id} className="thread-step"><span className="thread-step-label">Later</span>{next.title}</Go> : <span className="thread-step thread-step-empty"><span className="thread-step-label">Later</span>This is the latest</span>}
      </div>
    </nav>
  );
}

/** After the relationship cards: connections saved long before this reading. */
export function RevisitGroup({ reading }: { reading: Reading }) {
  const { items, route } = useStudy();
  const revisits = revisitPrompts(items, reading);
  if (revisits.length === 0) return null;
  return (
    <section className="relationship-group" aria-label="Worth revisiting">
      <h3>Worth revisiting</h3>
      {revisits.map(({ target, reason }) => (
        <article key={target.id} className="relationship-card relationship-card-revisit">
          <p className="relationship-kind">Saved {agoLabel(target.createdAt)}</p>
          <p className="relationship-title"><Go view="reading" id={target.id} extra={{ trail: [...route.trail, reading.id] }}>{target.title}</Go></p>
          <p className="relationship-reason">{reason}</p>
        </article>
      ))}
    </section>
  );
}
