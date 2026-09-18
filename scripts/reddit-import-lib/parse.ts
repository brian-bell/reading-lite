import { redditListingToMarkdown } from "../../src/modules/extractor/reddit";

export interface RedditImportRequest {
  source_url: string;
  markdown: string;
  title?: string;
  source_date?: string;
}

// Turn a raw Reddit listing `.json` payload (the 2-element [post, comments]
// array Reddit returns for a thread) into a markdown import request body.
//
// `url` is the original/canonical Reddit URL the reader pasted — it becomes the
// reading's `source_url` (by-url ownership key), independent of whatever host
// the JSON was fetched from. Returns null when the JSON isn't a parseable Reddit
// thread (e.g. a bot-challenge HTML page saved by mistake), so callers fail
// visibly instead of importing garbage.
export function buildRedditImport(url: string, jsonText: string): RedditImportRequest | null {
  const article = redditListingToMarkdown(jsonText);
  if (!article) return null;
  return {
    source_url: url,
    markdown: article.markdown,
    ...(article.title ? { title: article.title } : {}),
    ...(article.source_date === undefined ? {} : { source_date: article.source_date }),
  };
}
