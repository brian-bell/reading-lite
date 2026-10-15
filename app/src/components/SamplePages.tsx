import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { whoamiQueryOptions } from "../identity-query";
import { hasRelationships } from "../reading-relationships";
import { hostnameOf, publishedOn, sourceLabel } from "../reading-presentation";
import type { Reading } from "../reading";
import { SAMPLE_READINGS, sampleReading } from "../samples";
import { PageHeading } from "./PageHeading";
import { ContextJump, ReadingContext } from "./ReadingContext";
import { SampleNotFound } from "./ReadingStates";
import { ReadingNovelty, ReadingSummary } from "./ReadingSummary";
import { ReturnTrail, useTrail } from "./ReturnTrail";

// The public sample library (reading-lite-gh341.10): the bundled readings in
// samples.ts, open to anyone, signed in or not. `/samples` lists them;
// `/samples/:id` is a reading page built from the reading page's own parts —
// the Summary view, the novelty panel, and Connections & tensions, whose cards
// lead to other samples — with nothing that writes or reads the backend: no
// Reprocess, no Source view or Details (both are fetched), and tags that are
// labels rather than links into a library the reader may not have.
//
// The server render carries no identity (public-paths.ts), so the pages may
// be cached. The call to action follows the shell's identity read in the
// browser, after hydration: signed out it offers sign-in, signed in the
// reader's library.

export function SampleLibraryPage() {
  return (
    <div className="page library">
      <PageHeading>Sample library</PageHeading>
      <p className="auth-lede">
        Reading Lite summarizes what you save and connects it to what you have already read. These sample readings
        show how: open one to see its summary, what it adds, and the connections and tensions it has with the others.
      </p>
      <SampleCallToAction />
      <ul className="library-list" aria-label="Sample readings">
        {SAMPLE_READINGS.map((reading) => (
          <SampleCard key={reading.id} reading={reading} />
        ))}
      </ul>
    </div>
  );
}

/**
 * A library card for a sample: the title (stretched over the card, as the
 * library's is), the lead, and a line with the host and how many
 * relationships the reading has, which is what the samples are here to show.
 */
function SampleCard({ reading }: { reading: Reading }) {
  const related = relationshipCount(reading);
  return (
    <li className="library-card">
      <h2 className="library-card-title">
        <Link to="/samples/$id" params={{ id: reading.id }}>
          {reading.title ?? reading.url}
        </Link>
      </h2>
      {reading.tldr ? <p className="library-card-summary">{reading.tldr}</p> : null}
      <p className="library-card-meta">
        {hostnameOf(reading.url)}
        {related ? ` · ${related}` : null}
      </p>
    </li>
  );
}

/** "1 connection · 1 tension", or nothing for a reading with neither. */
export function relationshipCount(reading: Reading): string | undefined {
  const parts = [
    counted(reading.connections?.length ?? 0, "connection"),
    counted(reading.tensions?.length ?? 0, "tension"),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function counted(n: number, noun: string): string | undefined {
  if (n === 0) return undefined;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function SampleReadingPage({ id }: { id: string }) {
  const reading = sampleReading(id);
  if (!reading) return <SampleNotFound />;
  // Keyed, as the reading page is, so following a relationship to another
  // sample starts that page afresh.
  return <SampleReadingSurface key={reading.id} reading={reading} />;
}

function SampleReadingSurface({ reading }: { reading: Reading }) {
  const trail = useTrail();
  const published = publishedOn(reading.source_date);
  const source = sourceLabel(reading.source_type);
  const context = hasRelationships(reading);
  return (
    <div className="page reading">
      <article className="reading-column">
        <Link className="reading-back" to="/samples">
          All samples
        </Link>
        <ReturnTrail hops={trail} route="/samples/$id" />
        <div className="reading-head">
          <PageHeading>{reading.title ?? reading.url}</PageHeading>
          <p className="reading-meta">
            <span>Sample reading</span>
            <span>{hostnameOf(reading.url)}</span>
            {published ? <span>{published}</span> : null}
            {source ? <span>{source}</span> : null}
          </p>
        </div>
        <SampleTags tags={reading.tags} />
        <SampleCallToAction />
        {context ? <ContextJump /> : null}
        <ReadingSummary reading={reading} />
        <ReadingNovelty reading={reading} />
      </article>
      {context ? <ReadingContext reading={reading} route="/samples/$id" /> : null}
    </div>
  );
}

/** Tags as labels: a sample's tags would filter a library the reader may not have. */
function SampleTags({ tags }: { tags: string[] | undefined }) {
  if (!tags || tags.length === 0) return null;
  return (
    <ul className="reading-tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag}>
          <span className="tag tag-static">{tag}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a sample is, and where to go next. The shell reads identity in the
 * browser only on public pages (AppFrame), so the server render (and the
 * browser's first render, which hydrates it) offers sign-in, and a signed-in
 * reader then sees the way to their library. This only watches that read:
 * the shell's query is the one that asks, once, however many samples the
 * reader opens.
 */
function SampleCallToAction() {
  const { data: identity } = useQuery({ ...whoamiQueryOptions(), enabled: false });
  const signedIn = identity !== undefined && identity !== null;
  return (
    <aside className="sample-banner" aria-label="About the samples">
      <p>
        {signedIn
          ? "These are sample readings, not your library."
          : "These are sample readings. Sign in to save your own and see how they connect."}
      </p>
      {signedIn ? (
        <Link to="/library" className="button">
          Open your library
        </Link>
      ) : (
        <Link to="/login" className="button button-primary">
          Sign in
        </Link>
      )}
    </aside>
  );
}
