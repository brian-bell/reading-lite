import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { degradationNotice, noveltyPanel, summaryBodyBelowLead } from "../reading-presentation";
import type { Reading } from "../reading";

// The Summary view (#370, design spec: Data mapping, Novelty, Reading surface).
//
// Order inside the reading column, after the title, metadata line, tags, and
// status card: the degraded-source notice, the serif lead, the rendered
// summary, then the novelty panel. The Summary/Source tabs go around this in
// #372; until then Summary is the only view and needs no tab to select it.
//
// Everything here is either a manifest field or a sentence derived from one by
// a fixed rule in reading-presentation.ts. Nothing on this page is written
// about a reading the backend did not report.

export function ReadingSummary({ reading }: { reading: Reading }) {
  const notice = degradationNotice(reading.enrichment_degradation);
  const body = summaryBodyBelowLead(reading.tldr, reading.summary_markdown);
  const novelty = noveltyPanel(reading);
  // A reading with nothing summarized yet — a fresh pending one, or a failed
  // one — renders its status card and stops rather than showing empty
  // furniture. A reprocess of a ready reading keeps the summary it still has.
  if (!notice && !reading.tldr && !body && !novelty) return null;
  return (
    <div className="reading-summary">
      {notice ? <DegradedNotice>{notice}</DegradedNotice> : null}
      {reading.tldr ? <p className="reading-lead">{reading.tldr}</p> : null}
      {body ? <SummaryMarkdown markdown={body} /> : null}
      {novelty ? <NoveltyPanel label={novelty.label} sentence={novelty.sentence} /> : null}
    </div>
  );
}

/**
 * Acceptance matrix, Degraded YouTube: a muted notice, not a failure. The
 * reading is ready and worth reading; the notice says why the summary is
 * thinner than usual.
 */
function DegradedNotice({ children }: { children: string }) {
  return <p className="reading-notice">{children}</p>;
}

/**
 * `summary_markdown` (design spec, Source content: rendered without raw HTML,
 * through a sanitizer, at a readable width).
 *
 * The summarizer writes this text, so it is not the untrusted source the
 * Source view handles — but it is model output shaped by a captured page, and
 * the page is untrusted. Sanitizing costs nothing and means a prompt-injected
 * summary cannot put markup on this page. react-markdown does not render raw
 * HTML on its own; rehype-sanitize keeps that true if a plugin is ever added
 * beside it.
 */
function SummaryMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="reading-prose">
      <Markdown rehypePlugins={[rehypeSanitize]} components={{ a: SummaryLink, img: SummaryImage }}>
        {markdown}
      </Markdown>
    </div>
  );
}

/**
 * A summary never loads a remote image (design spec, Source content: "Do not
 * load remote images automatically, so image hosts don't learn what is being
 * read").
 *
 * Markdown image syntax survives the sanitizer — its schema allows `img` with
 * an http(s) `src` — so refusing it is the renderer's job, not the sanitizer's.
 * The Source view renders a placeholder with a "Load image" button because the
 * images there are the article's (#372). A summary is 2-6 paragraphs the
 * summarizer wrote; an image in one is not content the reader came for, so the
 * alt text stands in for it and no request is made.
 */
function SummaryImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return <span className="reading-prose-image">{alt}</span>;
}

/** Links leave for a third-party page, so they carry the same rel as the source view's. */
function SummaryLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/**
 * Novelty (design spec): the verdict's label and its fixed sentence, on the
 * accent surface with the accent rule.
 *
 * The similarity numbers behind the verdict go in Details (#373), not here.
 * "Familiar" links to the connections when there are any — that link arrives
 * with the connections section itself in #371, since there is nothing on this
 * page yet to link to.
 */
function NoveltyPanel({ label, sentence }: { label: string; sentence: string }) {
  return (
    <section className="novelty" aria-labelledby="novelty-heading">
      <h2 id="novelty-heading">What this adds</h2>
      <p className="novelty-verdict">{label}</p>
      <p className="novelty-sentence">{sentence}</p>
    </section>
  );
}
