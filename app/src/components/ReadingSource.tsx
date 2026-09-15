import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, useMemo, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { whoamiQueryKey, type Identity } from "../identity";
import type { Reading } from "../reading";
import { demotedHeading, imagePlaceholder, sourceKnownUnavailable, type HeadingTag } from "../reading-source";
import { sourceQueryOptions } from "../source-query";
import { ExternalLink } from "./ExternalLink";
import { DelayedText } from "./ReadingStates";

// The Source view (#372; design spec, Source content): the extracted Markdown,
// fetched in the browser once the view is selected and rendered without raw
// HTML through the sanitizer. Loading, failure, and the source-unavailable
// state all show inside the view, so the summary, novelty, and relationships
// around it stay usable whatever the source does.

export interface LoadedImages {
  /** Image URLs the reader has asked for; kept above the view so a tab switch does not forget them. */
  loaded: ReadonlySet<string>;
  onLoad: (src: string) => void;
}

export function ReadingSource({
  reading,
  onReadSummary,
  images,
}: {
  reading: Reading;
  onReadSummary: () => void;
  images: LoadedImages;
}) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const known = sourceKnownUnavailable(reading);
  const { data, error, isPending, refetch } = useQuery({
    ...sourceQueryOptions(queryClient, reading.id, identity),
    // A manifest that already says the source was not captured is not asked.
    enabled: !known,
  });

  if (known || data?.state === "unavailable") return <SourceUnavailable onReadSummary={onReadSummary} />;
  if (data?.state === "forbidden") return <SourceForbidden />;
  if (data?.state === "account-changed") return <SourceAccountChanged actingTenant={data.acting_tenant} />;
  if (error) return <SourceFailed message={error.message} onRetry={() => void refetch()} />;
  if (isPending || !data) return <SourceLoading />;
  return <SourceMarkdown markdown={data.markdown} base={reading.url} images={images} />;
}

/** 403: never a sign-out, and no Retry can change it (ReadingForbidden). */
function SourceForbidden() {
  return (
    <div className="source-failed">
      <p>You don't have access to this reading's source.</p>
    </div>
  );
}

/** 412: another tab signed this browser into a different account (ReadingAccountChanged). */
function SourceAccountChanged({ actingTenant }: { actingTenant?: string }) {
  return (
    <div className="source-failed">
      <p>This tab is signed in to a different account than the page expects. Reload to continue as the account signed in now.</p>
      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
      {actingTenant ? <p className="form-hint">Signed in as {actingTenant}.</p> : null}
    </div>
  );
}

/**
 * Acceptance matrix, Source unavailable: the source wasn't captured (or is
 * gone), and the rest of the reading is still there to read. "Import a copy"
 * joins the button once `/save` exists (Phase 4, #339).
 */
function SourceUnavailable({ onReadSummary }: { onReadSummary: () => void }) {
  return (
    <div className="source-unavailable">
      <h2>Source text is unavailable</h2>
      <p>The summary and connections are preserved, but the captured article can't be opened.</p>
      <div className="form-actions">
        <button type="button" className="button" onClick={onReadSummary}>
          Read summary
        </button>
      </div>
    </div>
  );
}

function SourceLoading() {
  return (
    <div className="source-loading" aria-busy="true">
      <DelayedText delayMs={300}>Loading source…</DelayedText>
    </div>
  );
}

function SourceFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="source-failed">
      <p>The source couldn't be loaded. {message}</p>
      <div className="form-actions">
        <button type="button" className="button button-primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * The captured page is untrusted, so the sanitizer's default schema decides
 * what reaches the DOM: raw HTML is dropped, `script` is stripped, and only
 * http(s) URLs survive on links and images. GFM gives imported Markdown its
 * tables, which then scroll in their own container (app.css, .reading-prose).
 * Headings, links, and images are the three elements the spec says something
 * about, so they are the three overridden here; links resolve against the
 * captured page's URL, and images remember what the reader loaded.
 */
function SourceMarkdown({ markdown, base, images }: { markdown: string; base: string; images: LoadedImages }) {
  const components = useMemo<Components>(
    () => ({
      ...SOURCE_COMPONENTS,
      a: ({ href, children }) => (
        <ExternalLink href={href} base={base}>
          {children}
        </ExternalLink>
      ),
      img: ({ src, alt }) => <SourceImage src={src} alt={alt} images={images} />,
    }),
    [base, images],
  );
  return (
    <div className="reading-prose reading-source">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}

const SOURCE_COMPONENTS: Components = {
  h1: demoted("h1"),
  h2: demoted("h2"),
  h3: demoted("h3"),
  h4: demoted("h4"),
  h5: demoted("h5"),
  h6: demoted("h6"),
  pre: ScrollablePre,
  table: ScrollableTable,
};

/**
 * Code blocks and tables scroll in their own container (design spec, Source
 * content), and a region that can scroll must be reachable from the keyboard
 * (WCAG 2.1.1; axe scrollable-region-focusable), so each is a tab stop. The
 * shell's focus-visible rule covers `[tabindex]`.
 */
function ScrollablePre({ node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  return <pre {...props} tabIndex={0} />;
}

function ScrollableTable({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  return <table {...props} tabIndex={0} />;
}

function demoted(tag: HeadingTag): Components[HeadingTag] {
  const target = demotedHeading(tag);
  return function DemotedHeading({ node: _node, ...props }) {
    return createElement(target, props);
  };
}

/**
 * Design spec, Source content: a remote image is never loaded on its own, so
 * image hosts don't learn what is being read. It renders as its alt text and
 * host with a "Load image" button; clicking loads that one image in place,
 * over `https:` only, without a referrer.
 */
function SourceImage({ src, alt, images }: { src?: string | Blob; alt?: string; images: LoadedImages }) {
  const url = typeof src === "string" ? src : undefined;
  const placeholder = imagePlaceholder(url);
  if (url !== undefined && images.loaded.has(url) && placeholder.loadable) {
    return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="source-image">
      <span className="source-image-alt">{alt || "Image"}</span>
      {placeholder.host ? <span className="source-image-host">{placeholder.host}</span> : null}
      {placeholder.loadable ? (
        <button type="button" className="source-image-load" onClick={() => images.onLoad(url!)}>
          Load image
        </button>
      ) : null}
    </span>
  );
}
