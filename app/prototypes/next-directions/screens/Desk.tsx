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
import { agoLabel, dateOn, hostOf, readings as authored, type InboxItem, type Reading } from "../samples";
import { Go, LibraryCard, PageHeading, ProviderCard } from "../shared";
import { PROVIDER_COPY, SAMPLE_IDS, TENSION_LABELS, deskOf, digestPreview, failureCopy, failureOf, reprocessFailed, stageLabel } from "../study";

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
  return (
    <div className="page desk">
      <PageHeading aside={<span className="page-count">{dateOn("2026-10-01T10:00:00Z")}</span>}>Desk</PageHeading>
      {onboarding ? <Onboarding step={sampleStep} /> : null}
      {!onboarding && (desk.needsYou.length > 0 || provider === "invalid") ? (
        <DeskSection title="Needs you">
          {provider === "invalid" ? (
            <DeskRow kind="danger" title={PROVIDER_COPY.invalid.status} note="Processing is paused until you replace it.">
              <Go view="provider" className="button">Replace key</Go>
            </DeskRow>
          ) : null}
          {desk.needsYou.map((reading) => (
            <DeskRow key={reading.id} kind="danger" title={reading.title} note={failureLine(reading)}>
              <Go view="reading" id={reading.id} className="button">Open</Go>
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {inbox.length > 0 ? (
        <DeskSection title="Inbox" note="Markdown your agents staged. Add it to your library or discard it; nothing is processed until you do.">
          {inbox.map((item) => <InboxRow key={item.id} item={item} />)}
        </DeskSection>
      ) : null}
      {desk.processing.length > 0 ? (
        <DeskSection title="Processing">
          {desk.processing.map((reading) => (
            <DeskRow key={reading.id} title={reading.title} note={`${stageLabel(reading.stage)} · saved ${agoLabel(reading.createdAt)}`}>
              <Go view="reading" id={reading.id} className="button">Status</Go>
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {!empty ? (
        <DeskSection title="On your desk" note={desk.onDesk.length ? `${desk.onDesk.length} of 3. Open the first to start a session.` : "Nothing yet. Put a reading here from the library, or from what arrived below."}>
          {desk.onDesk.map((reading, index) => (
            <DeskRow key={reading.id} title={reading.title} note={reading.tldr ?? hostOf(reading.url)} index={index + 1}>
              <Go view="reading" id={reading.id} className={index === 0 ? "button button-primary" : "button"}>{index === 0 ? "Start" : "Open"}</Go>
              <DeskToggle reading={reading} />
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {desk.readySince.length > 0 ? (
        <DeskSection title={`Ready since ${dateOn(lastVisit)}`} note="Processed since your last visit.">
          {desk.readySince.map((reading) => (
            <DeskRow key={reading.id} title={reading.title} note={reading.tldr ?? hostOf(reading.url)}>
              <Go view="reading" id={reading.id} className="button">Open</Go>
              <DeskToggle reading={reading} />
            </DeskRow>
          ))}
        </DeskSection>
      ) : null}
      {!onboarding ? (
        <div className="desk-footer">
          <DeskSection title="This week">
            <DeskRow title={`Next digest · ${digest.readings.length} reading${digest.readings.length === 1 ? "" : "s"} so far, ${digest.tensions.length} tension${digest.tensions.length === 1 ? "" : "s"}`} note={`Goes out ${digest.sendsOn} at 08:00, Europe/London.`}>
              <Go view="digest" className="button">Preview</Go>
            </DeskRow>
          </DeskSection>
          <DeskSection title="Provider">
            <DeskRow kind={provider === "connected" ? undefined : "danger"} title={PROVIDER_COPY[provider].status} note={provider === "connected" ? "$0.31 of $2.00 spent today · summary effort High" : PROVIDER_COPY[provider].note}>
              <Go view="provider" className="button">Settings</Go>
            </DeskRow>
          </DeskSection>
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

function DeskSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="desk-section" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      {note ? <p className="form-hint desk-section-note">{note}</p> : null}
      <ul className="desk-rows">{children}</ul>
    </section>
  );
}

function DeskRow({ title, note, kind, index, detail, plain, children }: {
  title: string;
  note: string;
  kind?: "danger";
  index?: number;
  /** Shown under the row at full width, such as an inbox item's preview. */
  detail?: ReactNode;
  /** The title in the UI face at a smaller size: an untitled inbox item named by its URL. */
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={kind ? "desk-row desk-row-danger" : "desk-row"}>
      {index ? <span className="desk-row-index" aria-hidden="true">{index}</span> : null}
      <div className="desk-row-text">
        <p className={plain ? "desk-row-title desk-row-title-plain" : "desk-row-title"}>{title}</p>
        <p className="desk-row-note">{note}</p>
      </div>
      <div className="desk-row-actions">{children}</div>
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
      <button type="button" className="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide preview" : "Preview"}</button>
      <button type="button" className="button button-primary" onClick={() => promote(item.id)}>Add to library</button>
      <button type="button" className="button button-quiet" onClick={() => discard(item.id)}>Discard</button>
    </DeskRow>
  );
}

/** Put a ready reading on the desk, or take it off. At most three at a time. */
export function DeskToggle({ reading }: { reading: Reading }) {
  const { deskIds, toggleDesk } = useStudy();
  const on = deskIds.includes(reading.id);
  const full = !on && deskIds.length >= 3;
  return (
    <button type="button" className="button button-quiet" aria-pressed={on} disabled={full} title={full ? "Three readings at a time" : undefined} onClick={() => toggleDesk(reading.id)}>
      {on ? "Take off desk" : "Put on desk"}
    </button>
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
