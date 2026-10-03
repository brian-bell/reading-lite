/**
 * Parts every direction composes: the shell, library cards and filters, the
 * reading surface with its slots, status and relationship cards, the return
 * trail, the save form, the inbox, and the provider card. They follow the
 * shipped Connected components (app/src/components) so each direction is
 * judged on what it changes, not on a re-drawn baseline.
 */
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon, useStudy } from "./context";
import { agoLabel, dateOn, hostOf, type Reading } from "./samples";
import {
  OUTCOMES,
  PROVIDER_COPY,
  TENSION_LABELS,
  allTags,
  failureCopy,
  failureOf,
  filterReadings,
  newestFirst,
  noveltyOf,
  relationshipCount,
  reprocessFailed,
  stageLabel,
  targetOf,
  type Route,
  type View,
} from "./study";

// ---- Navigation ------------------------------------------------------------

export function Go({ view, id, extra, className, children, ...rest }: {
  view: View;
  id?: string;
  extra?: Partial<Route>;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
}) {
  const { go, hrefFor } = useStudy();
  return (
    <a
      href={hrefFor(view, id, extra)}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        go(view, id, extra);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export type NavSpec = { view: View; label: string; icon: string; matches?: View[] };

export function Shell({ nav, children }: { nav: NavSpec[]; children: ReactNode }) {
  const { route, signedIn, scenario } = useStudy();
  const showAccount = !(scenario === "new-reader" && !signedIn);
  return (
    <div className="shell">
      <div className="shell-frame">
        <header className="shell-nav">
          <Go view={nav[0].view} className="brand" aria-label="Reading Lite home">
            <span className="brand-mark" aria-hidden="true">r.</span>
            <span className="brand-name" aria-hidden="true">reading lite</span>
          </Go>
          <nav aria-label="Main">
            <ul className="nav-items">
              {nav.map((item) => {
                const current = route.view === item.view || (item.matches ?? []).includes(route.view);
                return (
                  <li key={item.view}>
                    <Go view={item.view} className="nav-item" aria-current={current ? "page" : undefined}>
                      <Icon name={item.icon} size={22} />
                      <span>{item.label}</span>
                    </Go>
                  </li>
                );
              })}
            </ul>
            {showAccount ? (
              <div className="account-area">
                <Go view="provider" className="nav-item nav-item-account" aria-current={route.view === "provider" ? "page" : undefined}>
                  <span className="avatar" aria-hidden="true">B</span>
                  <span>Account</span>
                </Go>
              </div>
            ) : (
              <div className="account-area">
                <Go view="landing" className="nav-item">
                  <Icon name="user" size={22} />
                  <span>Sign in</span>
                </Go>
              </div>
            )}
          </nav>
        </header>
        <div className="shell-body">
          <main id="main" className="shell-main" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </div>
  );
}

export function PageHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="page-title" tabIndex={-1}>{children}</h1>
      {aside ? <div className="page-head-aside">{aside}</div> : null}
    </div>
  );
}

// ---- Library ---------------------------------------------------------------

export function StatusBadge({ reading }: { reading: Reading }) {
  if (reading.status === "pending") return <span className="status-badge status-badge-pending">Processing</span>;
  const failure = failureOf(reading);
  if (reading.status === "failed") {
    return (
      <span className="library-card-status">
        <span className="status-badge status-badge-failed">Failed</span>
        <span className="library-card-error">{failure ? failureCopy(failure).headline : "Processing failed."}</span>
      </span>
    );
  }
  if (reprocessFailed(reading)) {
    return (
      <span className="library-card-status">
        <span className="status-badge status-badge-reprocess-failed">Reprocess failed</span>
        {failure ? <span className="library-card-error">{failureCopy(failure).headline}</span> : null}
      </span>
    );
  }
  return null;
}

export function Tag({ tag, current }: { tag: string; current?: boolean }) {
  if (current) return <span className="tag tag-current">{tag}</span>;
  return <Go view="library" className="tag" extra={{ tag, q: "" }}>{tag}</Go>;
}

export function NoveltyChip({ reading }: { reading: Reading }) {
  const novelty = noveltyOf(reading);
  if (!novelty) return null;
  return <span className={`novelty-chip novelty-chip-${reading.novelty}`}>{novelty.label}</span>;
}

export function LibraryCard({ reading, extra, compact }: { reading: Reading; extra?: ReactNode; compact?: boolean }) {
  const { route } = useStudy();
  const badge = <StatusBadge reading={reading} />;
  return (
    <li className={compact ? "library-card library-card-compact" : "library-card"}>
      {badge}
      <h2 className="library-card-title">
        <Go view="reading" id={reading.id}>{reading.title}</Go>
      </h2>
      {!compact && reading.tldr ? <p className="library-card-summary">{reading.tldr}</p> : null}
      <p className="library-card-meta">
        <span>{hostOf(reading.url)}</span>
        <span>Saved {dateOn(reading.createdAt)}</span>
        {reading.sourceType === "markdown" ? <span>Imported Markdown</span> : null}
      </p>
      {reading.tags.length ? (
        <ul className="library-card-tags" aria-label="Tags">
          {reading.tags.map((tag) => <li key={tag}><Tag tag={tag} current={route.tag === tag} /></li>)}
        </ul>
      ) : null}
      {extra ? <div className="library-card-extra">{extra}</div> : null}
    </li>
  );
}

export function FilterBar({ placeholder = "Search titles and summaries" }: { placeholder?: string }) {
  const { route, go } = useStudy();
  const [draft, setDraft] = useState(route.q);
  const { items } = useStudy();
  const tags = allTags(items);
  const id = useId();
  function submit(event: FormEvent) {
    event.preventDefault();
    go(route.view, route.id, { q: draft.trim(), tag: route.tag });
  }
  return (
    <div className="library-filters">
      <form className="library-search-row" role="search" onSubmit={submit}>
        <label htmlFor={id} className="visually-hidden">Search</label>
        <input id={id} className="text-input" type="search" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="button">Search</button>
      </form>
      <div className="library-active-filters">
        {route.q ? (
          <Go view={route.view} id={route.id} extra={{ q: "", tag: route.tag }} className="tag tag-active" aria-label={`Clear search ${route.q}`}>
            “{route.q}” <Icon name="close" size={12} strokeWidth={2} />
          </Go>
        ) : null}
        {route.tag ? (
          <Go view={route.view} id={route.id} extra={{ q: route.q, tag: "" }} className="tag tag-active" aria-label={`Clear tag ${route.tag}`}>
            {route.tag} <Icon name="close" size={12} strokeWidth={2} />
          </Go>
        ) : (
          <ul className="tag-row" aria-label="Filter by tag">
            {tags.map((tag) => <li key={tag}><Tag tag={tag} /></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

export function useLibraryRows(): Reading[] {
  const { items, route } = useStudy();
  return newestFirst(filterReadings(items, { q: route.q, tag: route.tag }));
}

export function EmptyLibrary() {
  const { route, provider, scenario } = useStudy();
  if (route.q || route.tag) {
    return (
      <p className="library-message">
        Nothing matches{route.q ? ` “${route.q}”` : ""}{route.tag ? ` in ${route.tag}` : ""}.{" "}
        <Go view="library" extra={{ q: "", tag: "" }}>Clear filters</Go>
      </p>
    );
  }
  if (scenario === "new-reader" || provider === "missing") {
    return (
      <div className="empty-state">
        <p>Your library is empty.</p>
        <p className="form-hint">Connect your OpenAI key, then save your first reading. The <Go view="landing">sample library</Go> shows what a processed reading looks like.</p>
        <div className="form-actions"><Go view="provider" className="button button-primary">Connect your key</Go></div>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <p>Your library is empty.</p>
      <div className="form-actions"><Go view="save" className="button button-primary">Save a reading</Go></div>
    </div>
  );
}

// ---- Reading surface -------------------------------------------------------

export function ReturnTrail() {
  const { route, items, back } = useStudy();
  const previousId = route.trail.at(-1);
  if (!previousId) return null;
  const previous = items.find((r) => r.id === previousId) ?? { title: "the previous reading", id: previousId, connections: [], tensions: [] } as Pick<Reading, "title" | "id" | "connections" | "tensions">;
  const current = route.id;
  const hop = previous.connections.find((c) => c.id === current) ?? previous.tensions.find((t) => t.id === current);
  return (
    <div className="reading-trail">
      <p className="reading-trail-context">
        From <strong>{previous.title}</strong>
        {hop ? <span className="reading-trail-reason">: {hop.reason}</span> : null}
      </p>
      <button type="button" className="reading-trail-back" onClick={back}>
        <Icon name="back" size={14} strokeWidth={2} /> Back to {previous.title}
      </button>
    </div>
  );
}

export function ReadingTabs({ reading }: { reading: Reading }) {
  const { tabs, setTab } = useStudy();
  const selected = tabs[reading.id] ?? "summary";
  const sourceMissing = reading.source === null;
  const keys = ["summary", "source"] as const;
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = keys.indexOf(selected);
    const next = event.key === "ArrowRight" ? keys[(index + 1) % 2] : event.key === "ArrowLeft" ? keys[(index + 1) % 2] : event.key === "Home" ? keys[0] : event.key === "End" ? keys[1] : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(reading.id, next);
    document.getElementById(`tab-${reading.id}-${next}`)?.focus();
  }
  return (
    <div className="view-tabs">
      <div className="tablist" role="tablist" aria-label="Reading views" onKeyDown={onKeyDown}>
        {keys.map((key) => (
          <button
            key={key}
            id={`tab-${reading.id}-${key}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected === key}
            aria-controls={`panel-${reading.id}`}
            tabIndex={selected === key ? 0 : -1}
            onClick={() => setTab(reading.id, key)}
          >
            {key === "summary" ? "Summary" : "Source"}
          </button>
        ))}
      </div>
      <div id={`panel-${reading.id}`} role="tabpanel" className="tabpanel" tabIndex={0}>
        {selected === "summary" ? <SummaryView reading={reading} /> : sourceMissing ? <SourceUnavailable reading={reading} /> : <SourceView reading={reading} />}
      </div>
    </div>
  );
}

function SummaryView({ reading }: { reading: Reading }) {
  if (!reading.tldr) return <p className="form-hint">Nothing summarized yet.</p>;
  return (
    <div className="reading-summary">
      <div className="reading-lead">
        <p className="reading-lead-label">TL;DR</p>
        <p className="reading-lead-text">{reading.tldr}</p>
      </div>
      <div className="reading-prose">
        {(reading.summary ?? []).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
    </div>
  );
}

function SourceView({ reading }: { reading: Reading }) {
  return (
    <div className="reading-prose reading-source">
      {(reading.source ?? []).map((block, index) => (
        <div key={index}>
          {block.heading ? <h2>{block.heading}</h2> : null}
          <p>{block.text}</p>
        </div>
      ))}
    </div>
  );
}

function SourceUnavailable({ reading }: { reading: Reading }) {
  return (
    <div className="source-unavailable">
      <p>The extracted text isn't available for this reading.</p>
      <p className="form-hint">{reading.status === "ready" ? "The summary, novelty, and connections are still here. You can import a copy of the article as Markdown." : "It will appear once processing finishes."}</p>
    </div>
  );
}

export function NoveltyPanel({ reading }: { reading: Reading }) {
  const novelty = noveltyOf(reading);
  if (!novelty) return null;
  return (
    <section className="novelty" aria-labelledby={`novelty-${reading.id}`}>
      <h2 id={`novelty-${reading.id}`}>What this adds</h2>
      <p className="novelty-verdict">{novelty.label}</p>
      <p className="novelty-sentence">{novelty.sentence}</p>
    </section>
  );
}

export function Details({ reading }: { reading: Reading }) {
  if (reading.status !== "ready") return null;
  return (
    <details className="reading-details">
      <summary>Details</summary>
      <div className="reading-details-body">
        <DetailGroup label="Keywords" terms={reading.keywords} />
        <DetailGroup label="People" terms={reading.people} />
        <DetailGroup label="Organizations" terms={reading.orgs} />
        <p className="reading-details-fact">Similarity: {reading.similarityCount ?? 0} close reading{reading.similarityCount === 1 ? "" : "s"} when processed.</p>
        <p className="reading-details-fact">Open as file: extracted.md · raw.html</p>
      </div>
    </details>
  );
}

function DetailGroup({ label, terms }: { label: string; terms: string[] }) {
  if (terms.length === 0) return null;
  return (
    <div className="reading-details-group">
      <h3>{label}</h3>
      <ul className="reading-details-chips">{terms.map((term) => <li key={term} className="chip">{term}</li>)}</ul>
    </div>
  );
}

export function StatusCard({ reading }: { reading: Reading }) {
  const { checkStatus, retry, outcome, setOutcome } = useStudy();
  if (reading.status === "pending") {
    return (
      <div className="status-card" role="status">
        <p className="status-card-headline">{stageLabel(reading.stage)}…</p>
        <p className="status-card-detail">Saved {agoLabel(reading.createdAt)}. This page checks for a result on its own for a while; after that, use Check status.</p>
        <div className="status-card-actions">
          <button type="button" className="button" onClick={() => checkStatus(reading.id)}>Check status</button>
          <label className="form-hint outcome-control">
            Sample outcome{" "}
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </div>
    );
  }
  if (reading.status === "failed" && reading.error) {
    const copy = failureCopy(reading.error);
    return (
      <div className="status-card status-card-failed">
        <p className="status-card-headline">{copy.headline}</p>
        {copy.detail ? <p className="status-card-detail">{copy.detail}</p> : null}
        {copy.next ? <p className="status-card-detail">{copy.next}</p> : null}
        <div className="status-card-actions">
          {copy.settings ? <Go view="provider" className="button button-primary">{copy.settings}</Go> : null}
          <button type="button" className={copy.settings ? "button" : "button button-primary"} onClick={() => retry(reading.id)}>Retry</button>
          {copy.importCopy ? <button type="button" className="button">Import a copy</button> : null}
        </div>
      </div>
    );
  }
  // A ready reading whose reprocess failed keeps its earlier material below
  // this card; the way on is the confirmed Reprocess in the heading row,
  // never an unconfirmed Retry (design spec, Reading surface).
  const failure = failureOf(reading);
  if (reprocessFailed(reading) && failure) {
    const copy = failureCopy(failure);
    return (
      <div className="status-card status-card-failed">
        <p className="status-card-headline">Reprocess failed · {copy.headline}</p>
        {copy.detail ? <p className="status-card-detail">{copy.detail}</p> : null}
        <p className="status-card-detail">The summary and content from the earlier attempt are still here{reading.lastAttempt?.finishedAt ? `; the reprocess stopped ${agoLabel(reading.lastAttempt.finishedAt)}` : ""}. {copy.next ?? "Reprocess again from above when the page is reachable."}</p>
        {copy.settings ? <div className="status-card-actions"><Go view="provider" className="button">{copy.settings}</Go></div> : null}
      </div>
    );
  }
  return null;
}

export function RelationshipCards({ reading, children, extraGroup }: { reading: Reading; children?: ReactNode; extraGroup?: ReactNode }) {
  const { items } = useStudy();
  const headingId = `context-${reading.id}`;
  const hasAny = reading.connections.length > 0 || reading.tensions.length > 0;
  return (
    <aside className="reading-context" aria-labelledby={headingId}>
      {children}
      <h2 id={headingId} className="context-heading" tabIndex={-1}>Connections &amp; tensions</h2>
      {!hasAny ? (
        <p className="relationship-note">{reading.status === "ready" ? (reading.similarityCount === 0 ? "Your library had nothing close to compare with when this was processed." : "No connections or tensions were found.") : "Connections appear once processing finishes."}</p>
      ) : null}
      {reading.connections.length > 0 ? (
        <section className="relationship-group" aria-label="Connections">
          <h3>Connections</h3>
          {reading.connections.map((c) => <RelationshipCard key={c.id} id={c.id} reason={c.reason} target={targetOf(items, c.id)} />)}
        </section>
      ) : null}
      {reading.tensions.length > 0 ? (
        <section className="relationship-group" aria-label="Tensions">
          <h3>Tensions</h3>
          {reading.tensions.map((t) => <RelationshipCard key={t.id} id={t.id} reason={t.reason} label={TENSION_LABELS[t.kind]} tension target={targetOf(items, t.id)} />)}
        </section>
      ) : null}
      {extraGroup}
      <a className="context-return" href={`#jump-${reading.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`jump-${reading.id}`)?.focus(); }}>Back to the reading</a>
    </aside>
  );
}

export function RelationshipCard({ id, reason, label, tension, target }: { id: string; reason: string; label?: string; tension?: boolean; target: ReturnType<typeof targetOf> }) {
  const { follow } = useStudy();
  const removed = target === undefined;
  const className = ["relationship-card", tension ? "relationship-card-tension" : "", removed ? "relationship-card-removed" : ""].filter(Boolean).join(" ");
  return (
    <article className={className}>
      {removed ? <p className="relationship-kind">Reading removed</p> : label ? <p className="relationship-kind">{label}</p> : null}
      {target ? (
        <p className="relationship-title">
          <a href={`#reading/${id}`} onClick={(e) => { e.preventDefault(); follow(id); }}>{target.title}</a>
          {target.status !== "ready" ? <span className={`status-badge status-badge-${target.status}`}>{target.status === "pending" ? "Processing" : "Failed"}</span> : null}
        </p>
      ) : null}
      <p className="relationship-reason">{reason}</p>
    </article>
  );
}

/**
 * The reading surface, with slots: `before` above the heading, `afterMeta`
 * under the tags, `afterBody` under Details, `contextTop` above the
 * relationship cards and `contextExtra` after them.
 */
export function ReadingSurface({ reading, sample, before, afterMeta, afterBody, contextTop, contextExtra }: {
  reading: Reading;
  sample?: boolean;
  before?: ReactNode;
  afterMeta?: ReactNode;
  afterBody?: ReactNode;
  contextTop?: ReactNode;
  contextExtra?: ReactNode;
}) {
  const { retry, scenario, provider } = useStudy();
  const canReprocess = reading.status === "ready" && !sample && provider === "connected";
  return (
    <div className="page reading">
      <div className="reading-column">
        {before}
        <ReturnTrail />
        {sample ? <p className="sample-banner">A sample reading. Sign in and connect your key to save your own.</p> : null}
        <div className="reading-head-actions">
          <h1 className="page-title" tabIndex={-1}>{reading.title}</h1>
          <p className="reading-meta">
            <span>{hostOf(reading.url)}</span>
            <span>Saved {dateOn(reading.createdAt)}</span>
            {reading.sourceType === "markdown" ? <span>Imported Markdown</span> : null}
          </p>
          <div className="reading-actions">
            {canReprocess ? <button type="button" className="button" onClick={() => { if (window.confirm("Reprocess this reading? It costs a paid run and replaces the captured content.")) retry(reading.id); }}>Reprocess</button> : null}
            <a className="button" href={reading.url} onClick={(e) => e.preventDefault()}>Open original</a>
          </div>
        </div>
        {reading.tags.length ? (
          <ul className="reading-tags" aria-label="Tags">
            {reading.tags.map((tag) => <li key={tag}>{sample ? <span className="tag tag-static">{tag}</span> : <Tag tag={tag} />}</li>)}
          </ul>
        ) : null}
        {afterMeta}
        <a id={`jump-${reading.id}`} className="context-jump" href={`#context-${reading.id}`} tabIndex={0} onClick={(e) => { e.preventDefault(); document.getElementById(`context-${reading.id}`)?.focus(); }}>
          Connections &amp; tensions{relationshipCount(reading) ? ` · ${relationshipCount(reading)}` : ""}
        </a>
        {scenario !== "new-reader" || !sample ? <StatusCard reading={reading} /> : null}
        {reading.status === "ready" || reading.tldr ? <ReadingTabs reading={reading} /> : null}
        <NoveltyPanel reading={reading} />
        {!sample ? <Details reading={reading} /> : null}
        {afterBody}
      </div>
      <RelationshipCards reading={reading} extraGroup={contextExtra}>{contextTop}</RelationshipCards>
    </div>
  );
}

export function ReadingUnavailable() {
  const { route, back, home } = useStudy();
  const from = route.trail.at(-1);
  return (
    <div className="page reading-state">
      <h1 className="page-title" tabIndex={-1}>This reading isn't available</h1>
      <p>It may have been removed from your library.{from ? " The connection that led here is still shown on the reading you came from." : ""}</p>
      <div className="form-actions">
        {from ? <button type="button" className="button button-primary" onClick={back}>Back to the previous reading</button> : null}
        <button type="button" className="button" onClick={home}>Library</button>
      </div>
    </div>
  );
}

// ---- Save ------------------------------------------------------------------

export function SaveForm() {
  const { captureMode, setCaptureMode, capture, outcome, setOutcome, provider } = useStudy();
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noKey = provider !== "connected";
  function submit(event: FormEvent) {
    event.preventDefault();
    setError(capture(url, markdown));
  }
  return (
    <div className="save-card">
      {noKey ? (
        <p className="capture-refusal">
          Connect your OpenAI key before saving: processing runs with it. <Go view="provider">Connect a key</Go>
        </p>
      ) : null}
      <div className="tablist" role="tablist" aria-label="Capture">
        {(["url", "markdown"] as const).map((mode) => (
          <button key={mode} type="button" role="tab" className="tab" aria-selected={captureMode === mode} onClick={() => setCaptureMode(mode)}>
            {mode === "url" ? "URL" : "Markdown"}
          </button>
        ))}
      </div>
      <form className="save-form" onSubmit={submit}>
        {captureMode === "url" ? (
          <div className="field">
            <label className="field-label" htmlFor="save-url">Article URL</label>
            <input id="save-url" className="text-input" type="url" inputMode="url" value={url} placeholder="https://" aria-invalid={error ? true : undefined} onChange={(e) => setUrl(e.target.value)} />
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field-label" htmlFor="save-source">Source URL</label>
              <input id="save-source" className="text-input" type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="save-markdown">Markdown</label>
              <textarea id="save-markdown" className="text-input text-area" value={markdown} aria-invalid={error ? true : undefined} onChange={(e) => setMarkdown(e.target.value)} />
            </div>
          </>
        )}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={noKey}>{captureMode === "url" ? "Save" : "Import"}</button>
          <label className="form-hint outcome-control">
            Sample outcome{" "}
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <p className="form-hint">Nothing is fetched. A save creates a sample pending reading; Check status applies the chosen outcome.</p>
      </form>
    </div>
  );
}

export function SavePage() {
  return (
    <div className="page">
      <PageHeading>Save reading</PageHeading>
      <SaveForm />
    </div>
  );
}

// ---- Provider --------------------------------------------------------------

export function ProviderCard({ heading = "Provider" }: { heading?: string }) {
  const { provider, setProvider } = useStudy();
  const copy = PROVIDER_COPY[provider];
  return (
    <section className="provider-card" aria-label={heading}>
      <div className="provider-head">
        <span className="provider-mark" aria-hidden="true">AI</span>
        <div>
          <p className={`provider-status provider-status-${provider}`}>{copy.status}</p>
          <p className="provider-text">{copy.note}</p>
        </div>
      </div>
      {provider === "connected" ? (
        <p className="provider-usage">$0.31 of $2.00 spent today · resets at midnight UTC · summary effort High</p>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor="provider-key">OpenAI API key</label>
          <input id="provider-key" className="text-input" type="password" disabled value="" placeholder="Disabled in this study" />
          <p className="form-hint">Keys are checked with OpenAI before storage and never kept in the browser.</p>
        </div>
      )}
      <div className="form-actions">
        {provider === "connected" ? (
          <>
            <button type="button" className="button" onClick={() => setProvider("invalid")}>Simulate rejected key</button>
            <button type="button" className="button button-danger" onClick={() => setProvider("removed")}>Remove key</button>
          </>
        ) : (
          <button type="button" className="button button-primary" onClick={() => setProvider("connected")}>{provider === "invalid" ? "Replace with sample key" : "Connect sample key"}</button>
        )}
      </div>
    </section>
  );
}

export function ProviderPage() {
  return (
    <div className="page">
      <PageHeading>Account</PageHeading>
      <ProviderCard />
      <p className="form-hint provider-footnote">Sessions, API tokens, email, notifications, digests, export, and deletion are unchanged from the shipped account page and are not restated here.</p>
    </div>
  );
}
