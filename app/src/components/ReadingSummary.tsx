import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { degradationNotice, noveltyPanel, summaryBodyBelowLead } from "../reading-presentation";
import type { Reading } from "../reading";
import { ExternalLink } from "./ExternalLink";
import { CONTEXT_HEADING_ID, jumpTo } from "./ReadingContext";

// The Summary view (#370, design spec: Data mapping, Novelty, Reading surface).
//
// Order inside the reading column, after the title, metadata line, tags, and
// status card: the degraded-source notice, the serif lead, then the rendered
// summary. The Summary/Source tabs sit around this view (#372), and the
// novelty panel follows the tabs, below either view, so ReadingPage renders
// it separately (ReadingNovelty).
//
// Everything here is either a manifest field or a sentence derived from one by
// a fixed rule in reading-presentation.ts. Nothing on this page is written
// about a reading the backend did not report.

export function ReadingSummary({ reading }: { reading: Reading }) {
  const notice = degradationNotice(reading.enrichment_degradation);
  const body = summaryBodyBelowLead(reading.tldr, reading.summary_markdown);
  // A reading with nothing summarized yet — a fresh pending one, or a failed
  // one — renders its status card and stops rather than showing empty
  // furniture. A reprocess of a ready reading keeps the summary it still has.
  if (!notice && !reading.tldr && !body) return null;
  return (
    <div className="reading-summary">
      {notice ? <DegradedNotice>{notice}</DegradedNotice> : null}
      {reading.tldr ? <p className="reading-lead">{reading.tldr}</p> : null}
      {body ? <SummaryMarkdown markdown={body} /> : null}
    </div>
  );
}

/** The novelty panel, below whichever view is selected (design spec, Reading surface). */
export function ReadingNovelty({ reading }: { reading: Reading }) {
  const novelty = noveltyPanel(reading);
  if (!novelty) return null;
  return <NoveltyPanel label={novelty.label} sentence={novelty.sentence} linkToConnections={novelty.linksToConnections} />;
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
      <Markdown rehypePlugins={[rehypeSanitize]} components={{ a: ExternalLink, img: SummaryImage }}>
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
 * images there are the article's (ReadingSource). A summary is 2-6 paragraphs the
 * summarizer wrote; an image in one is not content the reader came for, so the
 * alt text stands in for it and no request is made.
 */
function SummaryImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return <span className="reading-prose-image">{alt}</span>;
}

/**
 * Novelty (design spec): the verdict's label and its fixed sentence, on the
 * accent surface with the accent rule.
 *
 * The similarity numbers behind the verdict go in Details (#373), not here.
 * "Familiar" links to the connections when there are any: the sentence stays
 * as written and the link follows it, so the copy the spec fixes is intact.
 */
function NoveltyPanel({
  label,
  sentence,
  linkToConnections,
}: {
  label: string;
  sentence: string;
  linkToConnections: boolean;
}) {
  return (
    <section className="novelty" aria-labelledby="novelty-heading">
      <h2 id="novelty-heading">What this adds</h2>
      <p className="novelty-verdict">{label}</p>
      <p className="novelty-sentence">
        {sentence}
        {linkToConnections ? (
          <>
            {" "}
            <a href={`#${CONTEXT_HEADING_ID}`} onClick={(event) => jumpTo(event, CONTEXT_HEADING_ID)}>
              See the connections
            </a>
          </>
        ) : null}
      </p>
    </section>
  );
}
