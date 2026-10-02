/**
 * The desk is home: what needs you, the inbox (Markdown an agent staged,
 * previewed, added, or discarded here), what is processing, the few readings
 * you put on the desk to read now, what arrived since your last visit, the
 * next digest, and the provider. The same surface carries a new reader from
 * the signed-out landing through samples, key, and first save. Needs a
 * per-reading desk flag and a digest preview read from the backend; the last
 * visit stays in the browser.
 */
import { useState, type ReactNode } from "react";
import { Icon, useStudy } from "../context";
import { STUDY_NOW, agoLabel, dayOn, hostOf, readings as authored, type InboxItem, type Reading } from "../samples";
import { Go, LibraryCard, PageHeading, ProviderCard } from "../shared";
import { PROVIDER_COPY, SAMPLE_IDS, TENSION_LABELS, deskOf, digestPreview, failureCopy, failureOf, reprocessFailed, stageLabel, type DigestPreview } from "../study";

/** How many readings the desk holds at once: a study value, not a product rule. */
const DESK_CAP = 3;

export function Landing() {
  const { signIn, signedIn } = useStudy();
  const samples = authored.filter((r) => SAMPLE_IDS.includes(r.id));
  return (
    <div className="page landing">
      <div className="landing-head">
        <h1 className="page-title landing-title" tabIndex={-1}>Reading Lite summarizes what you save and connects it to what you have already read.</h1>
        <p className="auth-lede">Save an article. Get its summary, what it adds to your library, and the readings it agrees or argues with. Your own OpenAI key does the work; the library is yours.</p>
      </div>
      <div className="landing-columns">
        <section className="landing-signin" aria-labelledby="landing-signin">
          <h2 id="landing-signin" className="section-title">Sign in</h2>
          <p className="form-hint">We'll email you a sign-in link. No password needed.</p>
          <div className="field">
            <label className="field-label" htmlFor="landing-email">Email</label>
            <input id="landing-email" className="text-input" type="email" placeholder="you@example.com" disabled />
          </div>
          <div className="form-actions">
            {signedIn ? <Go view="desk" className="button button-primary">Your desk</Go> : <button type="button" className="button button-primary" onClick={signIn}>Email me a link (sample)</button>}
          </div>
          <p className="form-hint">After signing in you connect an OpenAI key, then save your first reading. Until then the samples show what a processed reading looks like.</p>
        </section>
        <section className="landing-samples" aria-labelledby="landing-samples">
          <h2 id="landing-samples" className="section-title">Sample library</h2>
          <ul className="library-list">
            {samples.map((reading) => <LibraryCard key={reading.id} reading={reading} compact />)}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function DeskPage() {
  const { items, deskIds, lastVisit, inbox, provider, scenario, sampleStep } = useStudy();
  const desk = deskOf(items, deskIds, lastVisit);
  const onboarding = scenario === "new-reader";
  const empty = items.length === 0;
  const digest = digestPreview(items, inbox.length);
  const keyRejected = provider === "invalid";
  const needsYou = desk.needsYou.length + (keyRejected ? 1 : 0);
  return (
    <div className="page desk">
      <PageHeading aside={<time className="desk-date" dateTime={STUDY_NOW}>{dayOn(STUDY_NOW)}</time>}>Desk</PageHeading>
      {onboarding ? <Onboarding step={sampleStep} /> : null}
      {!onboarding && needsYou > 0 ? (
        <DeskSection title="Needs you" count={needsYou} tone="danger">
          {keyRejected ? (
            <DeskRow title={PROVIDER_COPY.invalid.status} note="Processing is paused until you replace it.">
              <Go view="provider" className="button">Replace key</Go>
            </DeskRow>
          ) : null}
          {desk.needsYou.map((reading) => (
            <DeskRow key={reading.id} title={reading.title} note={failureLine(reading)} to={reading.id} />
          ))}
        </DeskSection>
      ) : null}
      {inbox.length > 0 ? (
        <DeskSection title="Inbox" count={inbox.length} note="Markdown your agents staged. Add it to your library or discard it; nothing is processed until you do.">
          {inbox.map((item) => <InboxRow key={item.id} item={item} />)}
        </DeskSection>
      ) : null}
      {desk.processing.length > 0 ? (
        <DeskSection title="Processing" count={desk.processing.length}>
          {desk.processing.map((reading) => (
            <DeskRow key={reading.id} title={reading.title} note={`${stageLabel(reading.stage)} · saved ${agoLabel(reading.createdAt)}`} to={reading.id} live />
          ))}
        </DeskSection>
      ) : null}
      {!empty ? (
        <DeskSection
          title="On your desk"
          tone="focus"
          aside={<DeskSlots filled={desk.onDesk.length} />}
          note={desk.onDesk.length ? `${desk.onDesk.length} of ${DESK_CAP}. Open the first to start a session.` : undefined}
        >
          {desk.onDesk.length === 0 ? (
            <li className="desk-row desk-row-empty">
              <p className="desk-row-note">Nothing yet. Put a reading here from the library, or from what arrived below.</p>
            </li>
          ) : desk.onDesk.map((reading, index) => (
            <DeskRow key={reading.id} title={reading.title} note={reading.tldr ?? hostOf(reading.url)} to={reading.id} index={index + 1}>
              {index === 0 ? <Go view="reading" id={reading.id} className="button button-primary">Start</Go> : null}
              <DeskToggle reading={reading} compact />
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {desk.readySince.length > 0 ? (
        <DeskSection title={`Ready since ${dayOn(lastVisit)}`} count={desk.readySince.length} note="Processed since your last visit.">
          {desk.readySince.map((reading) => (
            <DeskRow key={reading.id} title={reading.title} note={reading.tldr ?? hostOf(reading.url)} to={reading.id}>
              <DeskToggle reading={reading} />
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {!onboarding ? (
        <div className="desk-tiles">
          <DigestTile digest={digest} />
          <ProviderTile />
        </div>
      ) : null}
    </div>
  );
}

/** What stopped: the failure's headline, prefixed when a reprocess failed over a reading that is still ready. */
function failureLine(reading: Reading): string {
  const failure = failureOf(reading);
  const headline = failure ? failureCopy(failure).headline : "Processing failed.";
  return reprocessFailed(reading) ? `Reprocess failed · ${headline}` : headline;
}

function Onboarding({ step }: { step: number }) {
  const { provider } = useStudy();
  const keyDone = provider === "connected";
  return (
    <section className="onboarding" aria-labelledby="onboarding-heading">
      <h2 id="onboarding-heading" className="section-title">Three steps to your first reading</h2>
      <ol className="onboarding-steps">
        <li className={step >= 1 ? "onboarding-step onboarding-done" : "onboarding-step"}>
          <span className="onboarding-mark" aria-hidden="true">{step >= 1 ? <Icon name="check" size={14} strokeWidth={2.2} /> : "1"}</span>
          <div>
            <p className="onboarding-title">See how a processed reading looks</p>
            <p className="form-hint">Each sample has a summary, a novelty verdict, and connections to the others. <Go view="landing">Open the samples</Go></p>
          </div>
        </li>
        <li className={keyDone ? "onboarding-step onboarding-done" : "onboarding-step"}>
          <span className="onboarding-mark" aria-hidden="true">{keyDone ? <Icon name="check" size={14} strokeWidth={2.2} /> : "2"}</span>
          <div>
            <p className="onboarding-title">Connect your OpenAI key</p>
            <p className="form-hint">Summaries and embeddings run with it; you pay OpenAI directly. Saving is off until a key is connected.</p>
            <ProviderCard heading="Provider key" />
          </div>
        </li>
        <li className="onboarding-step">
          <span className="onboarding-mark" aria-hidden="true">3</span>
          <div>
            <p className="onboarding-title">Save your first reading</p>
            <p className="form-hint">Your first reading has nothing to connect to yet; the second one will.</p>
            {keyDone ? <Go view="save" className="button button-primary">Save a reading</Go> : <span className="button" aria-disabled="true">Save a reading</span>}
          </div>
        </li>
      </ol>
    </section>
  );
}

function DeskSection({ title, count, note, tone, aside, children }: {
  title: string;
  /** Shown beside the title; the list itself carries the count for assistive technology. */
  count?: number;
  note?: string;
  /** `danger` rules the section's left edge; `focus` lifts it as the page's centre. */
  tone?: "danger" | "focus";
  /** Right of the title: the desk's slots. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const className = ["desk-section", tone ? `desk-section-${tone}` : ""].filter(Boolean).join(" ");
  return (
    <section className={className} aria-label={title}>
      <div className="desk-section-head">
        <h2 className="section-title">{title}</h2>
        {count !== undefined ? <span className="desk-section-count" aria-hidden="true">{count}</span> : null}
        {aside ? <div className="desk-section-aside">{aside}</div> : null}
        {note ? <p className="form-hint desk-section-note">{note}</p> : null}
      </div>
      <ul className="desk-rows">{children}</ul>
    </section>
  );
}

function DeskRow({ title, note, to, index, live, detail, plain, children }: {
  title: string;
  note: string;
  /** A reading id: the title links to it and the whole row is its target. */
  to?: string;
  /** The reading's place on the desk. */
  index?: number;
  /** A running attempt: a live mark before the title. */
  live?: boolean;
  /** Shown under the row at full width, such as an inbox item's preview. */
  detail?: ReactNode;
  /** The title in the UI face at a smaller size: an untitled inbox item named by its URL. */
  plain?: boolean;
  children?: ReactNode;
}) {
  const marked = index !== undefined || live;
  const className = ["desk-row", to ? "desk-row-linked" : "", marked ? "desk-row-marked" : ""].filter(Boolean).join(" ");
  return (
    <li className={className}>
      {index !== undefined ? <span className="desk-row-index" aria-hidden="true">{index}</span> : live ? <span className="desk-row-live" aria-hidden="true" /> : null}
      <div className="desk-row-text">
        <p className={plain ? "desk-row-title desk-row-title-plain" : "desk-row-title"}>
          {to ? <Go view="reading" id={to}>{title}</Go> : title}
        </p>
        <p className="desk-row-note">{note}</p>
      </div>
      {children ? (
        <div className="desk-row-actions">{children}</div>
      ) : to ? (
        <span className="desk-row-chevron" aria-hidden="true"><Icon name="chevron" size={16} strokeWidth={1.75} /></span>
      ) : null}
      {detail ? <div className="desk-row-detail">{detail}</div> : null}
    </li>
  );
}

/** An inbox item on the desk: preview in place, then add it to the library or discard it. */
function InboxRow({ item }: { item: InboxItem }) {
  const { promote, discard } = useStudy();
  const [open, setOpen] = useState(false);
  return (
    <DeskRow
      title={item.title ?? item.url}
      plain={item.title === null}
      note={`${hostOf(item.url)} · ${(item.bytes / 1024).toFixed(1)} KB · staged ${agoLabel(item.stagedAt)}`}
      detail={open ? <pre className="inbox-preview-text">{item.markdown}</pre> : undefined}
    >
      <button type="button" className="button button-quiet desk-row-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide preview" : "Preview"}
        <Icon name="chevron-down" size={14} strokeWidth={2} />
      </button>
      <button type="button" className="button" onClick={() => promote(item.id)}>Add to library</button>
      <button type="button" className="button button-quiet button-quiet-muted" onClick={() => discard(item.id)}>Discard</button>
    </DeskRow>
  );
}

/** The desk's three slots, filled left to right. */
function DeskSlots({ filled }: { filled: number }) {
  return (
    <span className="desk-slots" aria-hidden="true">
      {Array.from({ length: DESK_CAP }, (_, i) => <span key={i} className={i < filled ? "desk-slot desk-slot-filled" : "desk-slot"} />)}
    </span>
  );
}

/** Put a ready reading on the desk, or take it off. At most three at a time. `compact` is the desk's own × for a reading already there. */
export function DeskToggle({ reading, compact }: { reading: Reading; compact?: boolean }) {
  const { deskIds, toggleDesk } = useStudy();
  const on = deskIds.includes(reading.id);
  const full = !on && deskIds.length >= DESK_CAP;
  if (compact && on) {
    return (
      <button type="button" className="button button-icon" aria-label="Take off desk" title="Take off desk" onClick={() => toggleDesk(reading.id)}>
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
    );
  }
  return (
    <button type="button" className="button button-quiet" aria-pressed={on} disabled={full} title={full ? "Three readings at a time" : undefined} onClick={() => toggleDesk(reading.id)}>
      {on ? "Take off desk" : "Put on desk"}
    </button>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The week so far, as the next digest will carry it. */
function DigestTile({ digest }: { digest: DigestPreview }) {
  return (
    <section className="desk-tile" aria-label="This week">
      <h2 className="desk-tile-eyebrow">Next digest</h2>
      <p className="desk-tile-title">{plural(digest.readings.length, "reading")} and {plural(digest.tensions.length, "tension")} so far</p>
      <p className="desk-tile-meta">Goes out {digest.sendsOn} at 08:00, Europe/London. Readings processed before then are added.</p>
      <div className="desk-tile-actions"><Go view="digest" className="button">Preview</Go></div>
    </section>
  );
}

/** The provider at a glance: status, the key, and today's spend against its cap. */
function ProviderTile() {
  const { provider } = useStudy();
  const [status, ...rest] = PROVIDER_COPY[provider].status.split(" · ");
  const connected = provider === "connected";
  const tone = connected ? "positive" : provider === "invalid" ? "danger" : "muted";
  return (
    <section className="desk-tile" aria-label="Provider">
      <h2 className="desk-tile-eyebrow">Provider</h2>
      <p className="desk-tile-title">
        <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
        {status}
        {rest.length ? <span className="desk-tile-title-meta">{rest.join(" · ")}</span> : null}
      </p>
      {connected ? (
        <>
          <div className="spend-meter" aria-hidden="true"><span className="spend-meter-fill" style={{ width: "15.5%" }} /></div>
          <p className="desk-tile-meta">$0.31 of $2.00 today · resets at midnight UTC · summary effort High</p>
        </>
      ) : (
        <p className="desk-tile-meta">{PROVIDER_COPY[provider].note}</p>
      )}
      <div className="desk-tile-actions">
        <Go view="provider" className="button">{connected ? "Settings" : provider === "invalid" ? "Replace key" : "Connect a key"}</Go>
      </div>
    </section>
  );
}

/** Above a reading that is on the desk: where it sits in the session, done and next, pause. */
export function SessionBar({ reading }: { reading: Reading }) {
  const { deskIds, done, lookup } = useStudy();
  const index = deskIds.indexOf(reading.id);
  if (index < 0) return null;
  const next = deskIds[index + 1];
  const nextReading = next ? lookup(next)?.reading : undefined;
  return (
    <div className="session-bar" role="group" aria-label="Session">
      <p className="session-bar-text"><Icon name="desk" size={14} strokeWidth={2} /> On your desk · {index + 1} of {deskIds.length}{nextReading ? <span className="muted"> · next: {nextReading.title}</span> : null}</p>
      <div className="session-bar-actions">
        <button type="button" className="button button-primary" onClick={() => done(reading.id)}>{nextReading ? "Done, next" : "Done, clear the desk"}</button>
        <Go view="desk" className="button">Pause</Go>
      </div>
    </div>
  );
}

export function DigestPage() {
  const { items, inbox } = useStudy();
  const digest = digestPreview(items, inbox.length);
  return (
    <div className="page">
      <PageHeading aside={<Go view="desk" className="button">Back to desk</Go>}>Digest preview</PageHeading>
      <p className="form-hint">The weekly mail, in the app's own type and colors, as it stands for {digest.sendsOn} at 08:00. Readings processed before then are added.</p>
      <article className="digest-mail" aria-label="Digest mail">
        <p className="digest-subject">Your week in reading · {digest.period}</p>
        <p className="digest-lede">{digest.readings.length} new reading{digest.readings.length === 1 ? "" : "s"} so far, {digest.tensions.length} tension{digest.tensions.length === 1 ? "" : "s"}{digest.inboxCount ? `, ${digest.inboxCount} inbox item${digest.inboxCount === 1 ? "" : "s"} waiting` : ""}.</p>
        <h2 className="digest-heading">New this week</h2>
        <ul className="digest-list">
          {digest.readings.map((reading) => (
            <li key={reading.id}>
              <p className="digest-item-title"><Go view="reading" id={reading.id}>{reading.title}</Go></p>
              <p className="digest-item-meta">{hostOf(reading.url)} · {reading.novelty === "novel" ? "Novel" : reading.novelty === "familiar" ? "Familiar" : ""}</p>
              {reading.tldr ? <p className="digest-item-lead">{reading.tldr}</p> : null}
            </li>
          ))}
        </ul>
        {digest.tensions.length > 0 ? (
          <>
            <h2 className="digest-heading">Where they disagree</h2>
            <ul className="digest-list">
              {digest.tensions.map((pair) => (
                <li key={`${pair.a.id}|${pair.b.id}`}>
                  <p className="digest-item-title">{pair.a.title} <span className="tension-kind">{TENSION_LABELS[pair.kind]}</span> {pair.b.title}</p>
                  <p className="digest-item-lead">{pair.reason}</p>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="digest-footer">Sent by Reading Lite to the address on your account. Change the schedule or turn the digest off in Account.</p>
      </article>
    </div>
  );
}
